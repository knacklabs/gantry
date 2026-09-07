import { deriveAutoLaneAnalysis } from '../../application/permissions/auto-lane-analysis.js';
import {
  derivePermissionRememberContext,
  type LearnResult,
  type PermissionRememberContext,
} from '../../application/permissions/human-decision-learning.js';
import { gantryNativeCanonicalToolName } from '../../application/permissions/gantry-tool-risk.js';
import {
  computePermissionEffectHash,
  EFFECT_SCHEMA_VERSION,
  RAIL_CATALOG_VERSION,
} from '../../domain/permission-effect-key.js';
import type { PermissionDecisionMemoryRepository } from '../../domain/ports/permission-decision-memory.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import { resolveWorkspaceFolderPath } from '../../platform/workspace-folder.js';
import type { AutoLaneAnalysis } from '../../application/permissions/auto-lane-analysis-types.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
import { learnPermissionRememberSettlement } from '../../runtime/permission-remember-settlement.js';
import type { InlineCoreToolHostDeps } from './inline-agent-loop-tool-types.js';

export interface InlinePermissionMemoryInputs {
  analysis: AutoLaneAnalysis;
  effectHash?: string;
  workspaceRoot: string;
  decisionMemory?: PermissionDecisionMemoryRepository;
  personId?: string;
}

export function inlinePermissionMemoryInputs(input: {
  run: InlineAgentLoopLaneInput['input'];
  laneInput: InlineAgentLoopLaneInput;
  request: PermissionApprovalRequest;
  deps: Pick<InlineCoreToolHostDeps, 'getPermissionDecisionMemoryRepository'>;
}): InlinePermissionMemoryInputs {
  const workspaceRoot = resolveWorkspaceFolderPath(
    input.laneInput.group.folder,
  );
  const decisionMemory = input.deps.getPermissionDecisionMemoryRepository?.();
  const personId =
    input.run.isScheduledJob === true
      ? undefined
      : input.run.memoryUserId?.trim() || undefined;
  return {
    analysis: deriveAutoLaneAnalysis({
      permissionMode: input.run.permissionMode,
      hostJobId:
        input.run.isScheduledJob === true ? 'inline-scheduled' : undefined,
    }),
    effectHash: computePermissionEffectHash({
      request: input.request,
      workspaceRoot,
    }),
    workspaceRoot,
    ...(decisionMemory ? { decisionMemory } : {}),
    ...(personId ? { personId } : {}),
  };
}

export async function inlinePermissionRememberContext(input: {
  run: InlineAgentLoopLaneInput['input'];
  laneInput: InlineAgentLoopLaneInput;
  request: PermissionApprovalRequest;
  deps: Pick<InlineCoreToolHostDeps, 'getPermissionDecisionMemoryRepository'>;
}): Promise<PermissionRememberContext> {
  const facts = inlinePermissionMemoryInputs(input);
  return derivePermissionRememberContext({
    request: input.request,
    facts,
    laneInput: {
      permissionMode: input.run.permissionMode,
      ...(input.run.isScheduledJob === true
        ? { hostJobId: 'inline-scheduled' }
        : {}),
    },
    appId: input.run.appId || 'default',
    agentFolder: input.laneInput.group.folder,
    canonicalTool:
      gantryNativeCanonicalToolName(input.request.toolName)?.canonical ??
      input.request.toolName,
    personId: facts.personId,
    effectSchemaVersion: EFFECT_SCHEMA_VERSION,
    railVersion: RAIL_CATALOG_VERSION,
    kindVariant: 'category',
  });
}

export function inlineRememberSettlement(
  decision: PermissionApprovalDecision,
  deps: Pick<
    InlineCoreToolHostDeps,
    'getPermissionDecisionMemoryRepository' | 'warn'
  >,
): Promise<LearnResult | null> {
  return learnPermissionRememberSettlement({
    claim: decision.permissionCallbackClaim,
    repository: deps.getPermissionDecisionMemoryRepository?.(),
    warn: deps.warn,
  });
}
