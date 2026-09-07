import {
  rememberSettlementForClaim,
  updatePendingPermissionRememberContext,
} from '../application/interactions/pending-interaction-durability.js';
import { attachJobPermissionRequestOrDeny } from '../application/interactions/job-permission-durability.js';
import {
  derivePermissionRememberContext,
  learnRememberedDecision,
  type LearnResult,
  type PermissionRememberPromptFacts,
} from '../application/permissions/human-decision-learning.js';
import { HumanDecisionMemoryService } from '../application/permissions/human-decision-memory-service.js';
import { gantryNativeCanonicalToolName } from '../application/permissions/gantry-tool-risk.js';
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
  hostJobId?: string;
  onAttached: () => void;
  logger: { warn: Warn };
}): (
  request: PermissionApprovalRequest,
  facts?: PermissionRememberPromptFacts,
) => Promise<PermissionApprovalResult> {
  return async (request, facts) => {
    if (facts) {
      await persistPermissionRememberPromptContext({
        request,
        sourceAgentFolder: input.sourceAgentFolder,
        facts,
        personId: input.personId,
        hostJobId: input.hostJobId,
      });
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
  hostJobId?: string;
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
    effectSchemaVersion: EFFECT_SCHEMA_VERSION,
    railVersion: RAIL_CATALOG_VERSION,
    kindVariant: 'category',
  });
  if (!context.eligible) return true;
  return updatePendingPermissionRememberContext({
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId,
    context,
  });
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
