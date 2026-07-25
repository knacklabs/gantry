// Interactive request authentication must remain valid for the entire durable
// pending-interaction retention window. One bound drives both so they cannot
// drift apart.
export const IPC_INTERACTION_RETENTION_TTL_MS = 24 * 60 * 60_000;

export function ipcInteractionAuthEnvelopeOptions(unbounded: boolean): {
  separateAuthExpiry: true;
  authLifetimeMs?: number;
} {
  return {
    separateAuthExpiry: true,
    ...(unbounded ? { authLifetimeMs: IPC_INTERACTION_RETENTION_TTL_MS } : {}),
  };
}

export function ipcInteractionAuthValidationOptions(
  permissionLane: unknown,
): { maxAgeMs: number } | undefined {
  return permissionLane === 'interactive'
    ? { maxAgeMs: IPC_INTERACTION_RETENTION_TTL_MS }
    : undefined;
}

export function ipcInteractionUnclaimableReason(
  kind: 'permission' | 'question',
): string {
  return kind === 'permission'
    ? 'Permission request could not be claimed before its authenticated ingestion window expired. Retry the live request.'
    : 'Question could not be claimed before its authenticated ingestion window expired. Please ask again.';
}

export function ipcQuestionWaitExpiredReason(permissionLane: unknown): string {
  return permissionLane === 'interactive'
    ? ipcInteractionUnclaimableReason('question')
    : 'Question expired. Please ask again if this is still needed.';
}
