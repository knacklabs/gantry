import { deriveHumanDecisionScopeKey } from '../application/permissions/human-decision-scope.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
} from '../domain/human-decision.js';
import { decisionForMode } from '../domain/permission-decision.js';
import { PermissionLane } from '../domain/permission-lane.js';
import type {
  HumanDecisionMemoryCandidate,
  PermissionDecisionMemoryRepository,
  PermissionDecisionMemoryRow,
} from '../domain/ports/permission-decision-memory.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { RAIL_CATALOG_VERSION } from '../domain/permission-effect-key.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { AutoLaneAnalysis } from '../application/permissions/auto-lane-analysis-types.js';

export interface PermissionHumanMemoryStageInput {
  request: PermissionApprovalRequest;
  analysis?: AutoLaneAnalysis;
  effectHash?: string;
  workspaceRoot?: string;
  canonicalRoot?: string;
  decisionMemory?: PermissionDecisionMemoryRepository;
}

export async function consultRememberedDeny(
  input: PermissionHumanMemoryStageInput,
): Promise<PermissionApprovalDecision | undefined> {
  const actingPersonId = eligiblePerson(input);
  if (!actingPersonId) return undefined;
  const exact = await candidate(input, HumanDecisionOutcome.Deny, {
    scope: HumanDecisionScope.Exact,
  });
  if (!exact) return undefined;
  const row = await findHumanDecision(input, actingPersonId, [exact]);
  if (row?.outcome !== HumanDecisionOutcome.Deny) return undefined;
  return {
    ...decisionForMode(input.request, 'cancel', 'human_decision', 'machine'),
    reason: `denied by your remembered No to this exact command (${decisionDate(row)}) — /permissions to change`,
  };
}

export async function consultRememberedAllow(
  input: PermissionHumanMemoryStageInput,
  options: { exactOnly?: boolean } = {},
): Promise<PermissionApprovalDecision | undefined> {
  const actingPersonId = eligiblePerson(input);
  if (!actingPersonId) return undefined;
  const exact = await candidate(input, HumanDecisionOutcome.Allow, {
    scope: HumanDecisionScope.Exact,
  });
  const candidates = options.exactOnly
    ? exact
      ? [exact]
      : []
    : (
        await Promise.all([
          exact,
          candidate(input, HumanDecisionOutcome.Allow, {
            scope: HumanDecisionScope.Kind,
            trustGrowthTool: true,
          }),
          candidate(input, HumanDecisionOutcome.Allow, {
            scope: HumanDecisionScope.Kind,
            trustGrowthTool: false,
          }),
          candidate(input, HumanDecisionOutcome.Allow, {
            scope: HumanDecisionScope.Place,
            trustGrowthTool: true,
          }),
          candidate(input, HumanDecisionOutcome.Allow, {
            scope: HumanDecisionScope.Place,
            trustGrowthTool: false,
          }),
        ])
      ).filter((value): value is HumanDecisionMemoryCandidate =>
        Boolean(value),
      );
  if (candidates.length === 0) return undefined;
  const row = await findHumanDecision(input, actingPersonId, candidates);
  if (row?.outcome !== HumanDecisionOutcome.Allow) return undefined;
  const scope = scopeWords(row, input.canonicalRoot);
  if (!scope) return undefined;
  return {
    ...decisionForMode(
      input.request,
      'allow_once',
      'human_decision',
      'machine',
    ),
    reason: `allowed by your remembered Allow (${scope}, ${decisionDate(row)}) — /permissions to change`,
  };
}

function eligiblePerson(
  input: PermissionHumanMemoryStageInput,
): string | undefined {
  if (
    input.analysis?.lane !== PermissionLane.InteractiveAuto ||
    !input.decisionMemory ||
    input.effectHash === undefined
  ) {
    return undefined;
  }
  return input.request.personId?.trim() || undefined;
}

async function candidate(
  input: PermissionHumanMemoryStageInput,
  outcome: (typeof HumanDecisionOutcome)[keyof typeof HumanDecisionOutcome],
  options: {
    scope: (typeof HumanDecisionScope)[keyof typeof HumanDecisionScope];
    trustGrowthTool?: boolean;
  },
): Promise<HumanDecisionMemoryCandidate | undefined> {
  const derived = await deriveHumanDecisionScopeKey({
    outcome,
    scope: options.scope,
    request: input.request,
    effectHash: input.effectHash,
    workspaceRoot: input.workspaceRoot,
    canonicalRoot: input.canonicalRoot,
    trustGrowthTool: options.trustGrowthTool,
  });
  return derived.ok
    ? { scope: options.scope, scopeKey: derived.scopeKey }
    : undefined;
}

async function findHumanDecision(
  input: PermissionHumanMemoryStageInput,
  actingPersonId: string,
  candidates: HumanDecisionMemoryCandidate[],
): Promise<PermissionDecisionMemoryRow | null> {
  try {
    return await input.decisionMemory!.findHumanDecision({
      appId: input.request.appId ?? 'default',
      agentFolder: input.request.sourceAgentFolder,
      actingPersonId,
      candidates,
      railVersion: RAIL_CATALOG_VERSION,
    });
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : 'unknown' },
      'Human permission decision memory lookup failed',
    );
    return null;
  }
}

function scopeWords(
  row: PermissionDecisionMemoryRow,
  canonicalRoot: string | undefined,
): string | undefined {
  if (row.scope === HumanDecisionScope.Exact) return 'this exact action';
  if (row.scope === HumanDecisionScope.Kind)
    return 'this kind of action, anywhere';
  if (row.scope === HumanDecisionScope.Place && canonicalRoot)
    return `anything of this kind under ${canonicalRoot}`;
  return undefined;
}

function decisionDate(row: PermissionDecisionMemoryRow): string {
  return row.createdAt.slice(0, 10);
}
