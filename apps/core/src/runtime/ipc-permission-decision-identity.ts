import { executionAdmissionForAgent } from '../application/agents/agent-execution-admission.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import {
  systemPrincipal,
  type PrincipalRef,
} from '../domain/identity/principal-ref.js';
import { decisionForMode } from '../domain/permission-decision.js';
import type { PermissionApprovalDecision } from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { ParsedPermissionIpcRequest } from './ipc-parsing.js';

export async function resolvePermissionDecisionIdentity(input: {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  decision: PermissionApprovalDecision;
}): Promise<{ decision: PermissionApprovalDecision; actor: PrincipalRef }> {
  let decision = input.decision;
  const executionFailure = decision.approved
    ? await executionAdmissionForAgent({
        agentId:
          input.request.agentId ?? agentIdForFolder(input.sourceAgentFolder),
        getAgentRepository: input.deps.getAgentRepository,
      })
    : undefined;
  if (executionFailure) {
    decision = {
      ...decisionForMode(input.request, 'cancel', decision.decidedBy),
      permissionCallbackClaim: decision.permissionCallbackClaim,
      reason: executionFailure,
    };
  }

  let actor = await permissionDecisionActor({ ...input, decision });
  if (!actor && isHumanPermissionDecision(decision)) {
    decision = {
      ...decisionForMode(input.request, 'cancel', 'system'),
      permissionCallbackClaim: decision.permissionCallbackClaim,
      reason:
        'Permission approver identity could not be resolved. No action was taken.',
    };
    actor = systemPrincipal('permission:unresolved-approver');
  }
  return {
    decision,
    actor: actor ?? systemPrincipal(decision.decidedBy ?? 'permission'),
  };
}

function isHumanPermissionDecision(
  decision: PermissionApprovalDecision,
): boolean {
  return (
    decision.source === 'human_once' ||
    decision.source === 'human_persistent' ||
    decision.source === 'human_decision'
  );
}

async function permissionDecisionActor(input: {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  decision: PermissionApprovalDecision;
}): Promise<PrincipalRef | null> {
  if (!isHumanPermissionDecision(input.decision)) {
    return systemPrincipal(input.decision.decidedBy ?? 'permission');
  }
  const resolveApprover = input.deps.resolveControlApproverPrincipal;
  if (!resolveApprover) {
    return systemPrincipal(input.decision.decidedBy ?? 'permission');
  }
  const userId = input.decision.decidedBy?.trim();
  const conversationJid = input.request.targetJid?.trim();
  if (!userId || !conversationJid) return null;
  return resolveApprover({
    conversationJid,
    providerAccountId: input.request.providerAccountId,
    agentId: input.request.agentId,
    threadId: input.request.threadId,
    userId,
    sourceAgentFolder: input.sourceAgentFolder,
    decisionPolicy: input.request.decisionPolicy,
  });
}
