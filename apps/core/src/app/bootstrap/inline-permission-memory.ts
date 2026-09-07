import { deriveAutoLaneAnalysis } from '../../application/permissions/auto-lane-analysis.js';
import { computePermissionEffectHash } from '../../domain/permission-effect-key.js';
import type { PermissionDecisionMemoryRepository } from '../../domain/ports/permission-decision-memory.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
import { resolveWorkspaceFolderPath } from '../../platform/workspace-folder.js';
import type { AutoLaneAnalysis } from '../../application/permissions/auto-lane-analysis-types.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
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
