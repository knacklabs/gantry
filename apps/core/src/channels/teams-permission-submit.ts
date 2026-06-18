import { normalizePermissionAction } from './permission-interaction.js';

export function readTeamsPermissionDecision(value: unknown): {
  requestId: string;
  decision: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as {
    action?: unknown;
    requestId?: unknown;
    decision?: unknown;
    data?: unknown;
  };
  const candidate =
    payload.action === 'permission_decision'
      ? payload
      : payload.data && typeof payload.data === 'object'
        ? (payload.data as typeof payload)
        : null;
  if (!candidate || candidate.action !== 'permission_decision') return null;
  if (typeof candidate.requestId !== 'string') return null;
  if (
    typeof candidate.decision !== 'string' ||
    !normalizePermissionAction(candidate.decision)
  ) {
    return null;
  }
  return {
    requestId: candidate.requestId,
    decision: candidate.decision,
  };
}
