import type {
  PermissionApprovalCancellation,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import {
  pendingPermissionAliasesForCancellation,
  RUNNER_CANCELLED_PERMISSION_REASON,
} from '../interaction-settlement.js';

type PendingPermission = {
  request: Pick<
    PermissionApprovalRequest,
    'requestId' | 'appId' | 'sourceAgentFolder'
  >;
};

type PermissionSettlementCallbackResult =
  | 'settled'
  | 'already_decided'
  | 'ownerless'
  | 'retryable';

export async function cancelPendingTeamsPermission(
  pendingPermissions: ReadonlyMap<string, PendingPermission>,
  cancellation: PermissionApprovalCancellation,
  settle: (
    providerAlias: string,
    reason: string,
  ) => Promise<PermissionSettlementCallbackResult>,
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
