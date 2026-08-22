export {
  AUTH_TOKEN_BYTES,
  createAccessReference,
  createOpaqueToken,
  hashAuthToken,
  matchesAuthToken,
} from '../../shared/auth-tokens.js';

export type ConsoleRole = 'administrator' | 'viewer';
export type ConsoleAccessStatus = 'awaiting_approval' | 'active' | 'disabled';

export const LOCAL_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_REFERENCE_TTL_MS = 15 * 60 * 1000;
export const RECENT_REAUTH_MS = 10 * 60 * 1000;

export function expiresAt(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs);
}

export function isExpired(expiresAt: Date | string, now = new Date()): boolean {
  const expiresAtMs = new Date(expiresAt).getTime();
  const nowMs = now.getTime();
  return (
    !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(nowMs) ||
    expiresAtMs <= nowMs
  );
}

export function isRecentlyReauthenticated(
  reauthenticatedAt: Date | string | null | undefined,
  now = new Date(),
): boolean {
  return (
    reauthenticatedAt !== null &&
    reauthenticatedAt !== undefined &&
    !isExpired(expiresAt(new Date(reauthenticatedAt), RECENT_REAUTH_MS), now)
  );
}

export function canDisableOrDemote(
  role: ConsoleRole,
  status: ConsoleAccessStatus,
  activeAdministratorCount: number,
): boolean {
  return !(
    role === 'administrator' &&
    status === 'active' &&
    activeAdministratorCount <= 1
  );
}
