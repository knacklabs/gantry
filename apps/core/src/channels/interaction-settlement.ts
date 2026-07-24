import {
  getPermissionTimeoutMs,
  NO_PERMISSION_TIMEOUT_MS,
} from '../shared/permission-timeout.js';

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
