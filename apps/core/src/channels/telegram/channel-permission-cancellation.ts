import type {
  PermissionApprovalCancellation,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionCallbackScope,
} from '../../domain/types.js';
import {
  pendingPermissionAliasesForCancellation,
  RUNNER_CANCELLED_PERMISSION_REASON,
} from '../interaction-settlement.js';

export type PendingPermission = {
  callback: {
    providerAlias: string;
    scope: PermissionCallbackScope;
    matchKind: 'individual' | 'batch';
  };
  sourceAgentFolder: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  approvalContextJid?: string;
  request: PermissionApprovalRequest;
  chatId: string;
  messageId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: PermissionApprovalDecision) => void;
};

type PermissionSettlementResult =
  | 'settled'
  | 'already_decided'
  | 'ownerless'
  | 'retryable';

export async function cancelPendingTelegramPermission(
  pendingPermissions: ReadonlyMap<string, PendingPermission>,
  cancellation: PermissionApprovalCancellation,
  settle: (
    providerAlias: string,
    reason: string,
  ) => Promise<PermissionSettlementResult>,
): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'> {
  const aliases = pendingPermissionAliasesForCancellation(
    pendingPermissions,
    cancellation,
  );
  if (aliases.length === 0) return 'not_found';
  for (const providerAlias of aliases) {
    const result = await settle(
      providerAlias,
      cancellation.reason ?? RUNNER_CANCELLED_PERMISSION_REASON,
    );
    if (result === 'settled') return 'settled';
    if (result === 'retryable') return 'retryable';
  }
  return 'already_decided';
}
