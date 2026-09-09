import {
  DurableInteractionPersistenceError,
  rememberSettlementForClaim,
  updatePendingPermissionRememberContext,
} from '../application/interactions/pending-interaction-durability.js';
import { attachJobPermissionRequestOrDeny } from '../application/interactions/job-permission-durability.js';
import {
  derivePermissionRememberContext,
  learnRememberedDecision,
  type LearnResult,
  type PermissionRememberContext,
  type PermissionRememberPromptFacts,
} from '../application/permissions/human-decision-learning.js';
import { HumanDecisionMemoryService } from '../application/permissions/human-decision-memory-service.js';
import { buildPermissionCardAffordances } from '../application/permissions/permission-card-affordances.js';
import {
  gantryNativeCanonicalToolName,
  GantryToolRiskVerdict,
  gantryToolRisk,
} from '../application/permissions/gantry-tool-risk.js';
import type { PermissionCardAffordances } from '../domain/permission-card-affordances.js';
import type { PermissionDecisionMemoryRepository } from '../domain/ports/permission-decision-memory.js';
import {
  EFFECT_SCHEMA_VERSION,
  RAIL_CATALOG_VERSION,
} from '../domain/permission-effect-key.js';
import { PermissionLane } from '../domain/permission-lane.js';
import type {
  PermissionApprovalRequest,
  PermissionApprovalResult,
  PermissionCallbackClaimReference,
} from '../domain/types.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import type { IpcDeps } from './ipc-domain-types.js';

type Warn = (context: Record<string, unknown>, message: string) => void;

export function rememberingPermissionApprovalRequester(input: {
  deps: IpcDeps;
  sourceAgentFolder: string;
  personId?: string;
  personLabel?: string;
  hostJobId?: string;
  onAttached: () => void;
  logger: { warn: Warn };
}): (
  request: PermissionApprovalRequest,
  facts?: PermissionRememberPromptFacts,
) => Promise<PermissionApprovalResult> {
  return async (request, facts) => {
    if (facts) {
      const persisted = await persistPermissionRememberPromptContext({
        request,
        sourceAgentFolder: input.sourceAgentFolder,
        facts,
        personId: input.personId,
        personLabel: input.personLabel,
        hostJobId: input.hostJobId,
        repository: input.deps.getPermissionDecisionMemoryRepository?.(),
        warn: input.logger.warn,
      });
      if (!persisted) {
        throw new DurableInteractionPersistenceError(
          'Pending permission remember context could not be persisted',
        );
      }
    }
    if (!request.jobId) return input.deps.requestPermissionApproval(request);
    const outcome = await attachJobPermissionRequestOrDeny({
      request: request as PermissionApprovalRequest & { jobId: string },
      sourceAgentFolder: input.sourceAgentFolder,
      durability: input.deps.jobPermissionDurability,
      logger: input.logger,
    });
    if (outcome.status === 'attached') input.onAttached();
    return {
      kind: 'decision',
      decision: {
        approved: false,
        mode: 'cancel',
        decidedBy: 'job_permission_durability',
        ...(outcome.status === 'attached' ? {} : { reason: outcome.reason }),
      },
    };
  };
}

export async function persistPermissionRememberPromptContext(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  facts: PermissionRememberPromptFacts;
  personId?: string;
  personLabel?: string;
  hostJobId?: string;
  repository?: PermissionDecisionMemoryRepository;
  warn: Warn;
}): Promise<boolean> {
  const laneInput = {
    permissionMode: permissionModeForLane(input.facts.analysis.lane),
    ...(input.hostJobId ? { hostJobId: input.hostJobId } : {}),
  };
  const context = await derivePermissionRememberContext({
    request: input.request,
    facts: input.facts,
    laneInput,
    appId: input.request.appId || 'default',
    agentFolder: input.sourceAgentFolder,
    canonicalTool:
      gantryNativeCanonicalToolName(input.request.toolName)?.canonical ??
      input.request.toolName,
    personId: input.personId,
    personLabel: input.personLabel,
    effectSchemaVersion: EFFECT_SCHEMA_VERSION,
    railVersion: RAIL_CATALOG_VERSION,
    kindVariant: 'category',
  });
  if (!context.eligible) return true;
  const model = await buildPermissionRememberPromptModel({
    request: input.request,
    context,
    canonicalRoot: input.facts.canonicalRoot,
    repository: input.repository,
    warn: input.warn,
  });
  input.request.cardAffordances = model.cardAffordances;
  return updatePendingPermissionRememberContext({
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId,
    context: model.rememberContext,
    cardAffordances: model.cardAffordances,
  });
}

export async function buildPermissionRememberPromptModel(input: {
  request: PermissionApprovalRequest;
  context: PermissionRememberContext;
  canonicalRoot?: string;
  repository?: PermissionDecisionMemoryRepository;
  warn: Warn;
}): Promise<{
  rememberContext: PermissionRememberContext;
  cardAffordances: PermissionCardAffordances;
}> {
  let context = input.context;
  const service = input.repository
    ? new HumanDecisionMemoryService({ repository: input.repository })
    : undefined;
  const cardAffordances = await buildPermissionCardAffordances({
    request: input.request,
    rememberContext: context,
    canonicalRoot: input.canonicalRoot,
    highRisk:
      gantryToolRisk({
        toolName: input.request.toolName,
        toolInput: input.request.classifierToolInput ?? input.request.toolInput,
      }).verdict === GantryToolRiskVerdict.High,
    ...(service && context.personId
      ? {
          countExactAllowsByTool: async () =>
            (
              await service.countExactAllowsByTool({
                appId: context.appId,
                agentFolder: context.agentFolder,
                actingPersonId: context.personId!,
                railVersion: context.railVersion,
              })
            )[context.canonicalTool] ?? 0,
        }
      : {}),
    warn: input.warn,
  });
  if (cardAffordances.offered.includes('remember_allow_kind')) {
    context = { ...context, kindVariant: 'tool' };
  }
  return { rememberContext: context, cardAffordances };
}

export async function learnPermissionRememberSettlement(input: {
  claim?: PermissionCallbackClaimReference;
  repository?: PermissionDecisionMemoryRepository;
  warn: Warn;
}): Promise<LearnResult | null> {
  if (!input.claim || !input.repository) return null;
  try {
    const settlement = await rememberSettlementForClaim(input.claim);
    if (!settlement?.resolution.remember) return null;
    return learnRememberedDecision({
      context: settlement.context,
      resolution: settlement.resolution.remember,
      service: new HumanDecisionMemoryService({ repository: input.repository }),
      warn: input.warn,
    });
  } catch (err) {
    try {
      input.warn(
        { err, claim: input.claim },
        'Failed to learn remembered permission decision',
      );
    } catch {
      // The warning sink must not break the once-only permission result.
    }
    return { status: 'unlearned' };
  }
}

function permissionModeForLane(lane: PermissionLane): PermissionMode {
  if (lane === PermissionLane.InteractiveAuto) return 'auto';
  if (lane === PermissionLane.AutoStrict) return 'auto_strict';
  return 'ask';
}
