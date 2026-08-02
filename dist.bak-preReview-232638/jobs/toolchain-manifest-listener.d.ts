import type { Pool } from 'pg';
/**
 * Wake source for the worker capability reconciler. A subscriber is invoked on
 * every manifest change wakeup; the reconciler also polls on an interval so a
 * dropped NOTIFY is recovered. Injectable so unit tests drive wakeups without a
 * real Postgres connection.
 */
export interface ManifestWakeupSource {
    subscribe(listener: () => void): () => void;
    close(): Promise<void>;
}
/**
 * Postgres LISTEN-backed wake source mirroring the runtime-event notifier's
 * reconnect pattern: a dedicated client LISTENs the manifest channel, and on
 * connection failure it wakes subscribers (so the poll fallback catches up) and
 * reconnects with a fixed backoff. Stoppable via {@link close}.
 */
export declare class PostgresManifestWakeupSource implements ManifestWakeupSource {
    private readonly pool;
    private readonly logWarn?;
    private readonly listeners;
    private clientPromise;
    private client;
    private reconnectTimer;
    private closed;
    constructor(pool: Pool, logWarn?: ((context: Record<string, unknown>, message: string) => void) | undefined);
    subscribe(listener: () => void): () => void;
    close(): Promise<void>;
    private ensureListening;
    private handleClientFailure;
    private releaseClient;
    private wakeListeners;
    private scheduleReconnect;
}
