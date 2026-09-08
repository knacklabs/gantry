import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import {
  isPrincipalRef,
  systemPrincipal,
  type PrincipalRef,
} from '../../domain/identity/principal-ref.js';
import type { PermissionRepository } from '../../domain/ports/repositories.js';
import type {
  PermissionDecision,
  PermissionDecisionId,
} from '../../domain/permissions/permissions.js';
import type { PermissionApprovalDecision } from '../../domain/types.js';
import { permissionDecisionExpiresAt } from './permission-decision-expiry.js';

export interface RecordPermissionDecisionInput {
  appId: AppId;
  agentId?: AgentId;
  requestId: string;
  toolName: string;
  decision: PermissionApprovalDecision;
  permissionRepository?: PermissionRepository;
  conversationId?: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
  toolId?: string;
  auditMetadata?: Record<string, unknown>;
  actor?: PrincipalRef;
}

function auditPrincipal(input: RecordPermissionDecisionInput): PrincipalRef {
  const actor: unknown = input.actor;
  if (isPrincipalRef(actor)) return actor;
  if (typeof actor === 'string' && actor.trim()) return systemPrincipal(actor);
  return systemPrincipal(input.decision.decidedBy?.trim() || 'permission');
}

export async function recordPermissionDecision(
  input: RecordPermissionDecisionInput,
  now: string,
): Promise<void> {
  if (!input.permissionRepository) return;
  const decision: PermissionDecision = {
    id: `permission-decision:${globalThis.crypto.randomUUID()}` as PermissionDecisionId,
    appId: input.appId,
    ruleIds: [],
    runId: input.runId as never,
    effect: input.decision.approved ? 'allow' : 'deny',
    reason:
      input.decision.reason ||
      (input.decision.approved ? 'Permission approved' : 'Permission denied'),
    actorContext: {
      requestId: input.requestId,
      origin: 'permission_management_service',
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      mode: input.decision.mode ?? null,
      classification: input.decision.decisionClassification ?? null,
      ...(input.auditMetadata ?? {}),
    },
    actionPreview: input.toolName,
    toolId: input.toolId as never,
    approverRef: auditPrincipal(input),
    expiresAt: permissionDecisionExpiresAt(input.decision, now),
    createdAt: now,
  };
  await input.permissionRepository.saveDecision(decision);
}
