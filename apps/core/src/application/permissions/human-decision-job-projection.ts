import {
  HumanDecisionOutcome,
  HumanDecisionScope,
} from '../../domain/human-decision.js';
import type {
  HumanDecisionMemoryCandidate,
  PermissionDecisionMemoryRepository,
} from '../../domain/ports/permission-decision-memory.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
import { RAIL_CATALOG_VERSION } from '../../domain/permission-effect-key.js';
import { deriveHumanDecisionScopeKey } from './human-decision-scope.js';

export interface ProjectedHumanDecisionMatch {
  recordId: string;
  scope: (typeof HumanDecisionScope)[keyof typeof HumanDecisionScope];
}

export async function projectHumanDecisionMatch(input: {
  ownerPersonId: string | null;
  request: PermissionApprovalRequest;
  facts: { effectHash?: string; workspaceRoot: string; canonicalRoot?: string };
  railVersion: typeof RAIL_CATALOG_VERSION;
  memory: PermissionDecisionMemoryRepository;
  warn(message: string, context?: Record<string, unknown>): void;
}): Promise<ProjectedHumanDecisionMatch | null> {
  const actingPersonId = input.ownerPersonId?.trim();
  if (!actingPersonId) return null;
  const candidates = (
    await Promise.all([
      candidate(input, HumanDecisionScope.Exact),
      candidate(input, HumanDecisionScope.Kind, true),
      candidate(input, HumanDecisionScope.Kind, false),
      candidate(input, HumanDecisionScope.Place, true),
      candidate(input, HumanDecisionScope.Place, false),
    ])
  ).filter((value): value is HumanDecisionMemoryCandidate => Boolean(value));
  if (candidates.length === 0) return null;
  try {
    const row = await input.memory.findHumanDecision({
      appId: input.request.appId ?? 'default',
      agentFolder: input.request.sourceAgentFolder,
      actingPersonId,
      candidates,
      railVersion: input.railVersion,
    });
    return row?.outcome === HumanDecisionOutcome.Allow && row.scope
      ? { recordId: row.id, scope: row.scope }
      : null;
  } catch (error) {
    input.warn('Human permission decision job projection lookup failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

async function candidate(
  input: Parameters<typeof projectHumanDecisionMatch>[0],
  scope: (typeof HumanDecisionScope)[keyof typeof HumanDecisionScope],
  trustGrowthTool?: boolean,
): Promise<HumanDecisionMemoryCandidate | undefined> {
  const derived = await deriveHumanDecisionScopeKey({
    outcome: HumanDecisionOutcome.Allow,
    scope,
    request: input.request,
    effectHash: input.facts.effectHash,
    workspaceRoot: input.facts.workspaceRoot,
    canonicalRoot: input.facts.canonicalRoot,
    trustGrowthTool,
  });
  return derived.ok ? { scope, scopeKey: derived.scopeKey } : undefined;
}
