import {
  getPermissionTimeoutMs,
  NO_PERMISSION_TIMEOUT_MS,
} from '../shared/permission-timeout.js';
import type {
  PermissionApprovalCancellation,
  PermissionApprovalRequest,
} from '../domain/types.js';

export const RUNNER_CANCELLED_PERMISSION_REASON =
  'Permission request cancelled by its runner.';

export function pendingPermissionAliasesForCancellation<
  Pending extends {
    request: Pick<
      PermissionApprovalRequest,
      'requestId' | 'appId' | 'sourceAgentFolder'
    >;
  },
>(
  pendingByAlias: ReadonlyMap<string, Pending>,
  cancellation: PermissionApprovalCancellation,
): string[] {
  const appId = cancellation.appId || 'default';
  return [...pendingByAlias]
    .filter(
      ([, pending]) =>
        pending.request.requestId === cancellation.requestId &&
        pending.request.sourceAgentFolder === cancellation.sourceAgentFolder &&
        (pending.request.appId || 'default') === appId,
    )
    .map(([providerAlias]) => providerAlias);
}

export function resolveInteractionSettlementDelayMs(input: {
  expiresAt?: unknown;
  permissionLane?: 'interactive' | 'autonomous';
  fallbackTimeoutMs?: number;
}): number | undefined {
  const expiresAtMs =
    typeof input.expiresAt === 'string'
      ? Date.parse(input.expiresAt)
      : Number.NaN;
  if (Number.isFinite(expiresAtMs)) {
    return Math.max(0, expiresAtMs - Date.now());
  }
  if (input.permissionLane) {
    const timeoutMs = getPermissionTimeoutMs(input.permissionLane);
    return timeoutMs > NO_PERMISSION_TIMEOUT_MS ? timeoutMs : undefined;
  }
  if (
    input.fallbackTimeoutMs !== undefined &&
    input.fallbackTimeoutMs > NO_PERMISSION_TIMEOUT_MS
  ) {
    return input.fallbackTimeoutMs;
  }
  return undefined;
}
