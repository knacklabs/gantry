// Cancellation authentication must remain valid for the entire directory
// retention/retry window. One bound drives both so they cannot drift apart.
export const IPC_CANCELLATION_RETENTION_TTL_MS = 24 * 60 * 60_000;
