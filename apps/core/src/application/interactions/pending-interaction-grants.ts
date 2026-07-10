import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import {
  applyRecoveredPersistentPermissionGrant,
  type PermissionPersistenceBackend,
} from './pending-interaction-permission-recovery.js';

export interface PermissionInteractionDecisionInput {
  request: PermissionApprovalRequest | null;
  sourceAgentFolder: string;
  decision: PermissionApprovalDecision;
  appId?: string | null;
  runId?: string | null;
  runLeaseToken?: string | null;
  runLeaseFencingVersion?: number | null;
  toolName: string;
  requestId: string;
}

interface PermissionInteractionGrantDependencies {
  permissionPersistence: PermissionPersistenceBackend | null;
  recordRunScopedTransientGrant(input: {
    appId?: string | null;
    runId: string;
    runLeaseToken?: string | null;
    runLeaseFencingVersion?: number | null;
    grant: Record<string, unknown>;
    expiresAtMs?: number;
  }): Promise<void>;
}

export async function applyPendingInteractionGrantDecision(
  input: PermissionInteractionDecisionInput,
  dependencies: PermissionInteractionGrantDependencies,
): Promise<boolean> {
  if (!input.decision.approved) return true;
  if (
    input.decision.mode === 'allow_persistent_rule' &&
    input.decision.decisionClassification === 'user_permanent'
  ) {
    if (!input.request || !dependencies.permissionPersistence) return false;
    return applyRecoveredPersistentPermissionGrant({
      persistence: dependencies.permissionPersistence,
      request: {
        ...input.request,
        requestId: input.requestId,
        sourceAgentFolder: input.sourceAgentFolder,
      },
      sourceAgentFolder: input.sourceAgentFolder,
      decision: input.decision,
    });
  }
  if (input.decision.decisionClassification === 'user_permanent') return true;
  if (!input.runId) return true;
  await dependencies.recordRunScopedTransientGrant({
    appId: input.appId,
    runId: input.runId,
    runLeaseToken: input.runLeaseToken,
    runLeaseFencingVersion: input.runLeaseFencingVersion,
    grant: {
      toolName: input.toolName,
      mode: input.decision.mode,
      requestId: input.requestId,
    },
    expiresAtMs: input.decision.timedGrantExpiresAtMs,
  });
  return true;
}
