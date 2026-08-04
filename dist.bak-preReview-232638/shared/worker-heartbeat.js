export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
// A worker that misses three heartbeats is considered unhealthy and its
// expired leases become recoverable by other workers.
export const WORKER_STALE_AFTER_MS = 3 * WORKER_HEARTBEAT_INTERVAL_MS;
