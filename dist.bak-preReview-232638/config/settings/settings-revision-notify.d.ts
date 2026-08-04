import type { Pool } from 'pg';
/**
 * pg_notify channel the fleet settings desired-state writer publishes to and
 * worker revision listeners LISTEN on. Carried as a plain literal so publisher
 * and listener cannot drift (mirrors `gantry_runtime_dependencies`).
 */
export declare const SETTINGS_REVISION_CHANNEL = "gantry_settings_revisions";
export interface SettingsRevisionWakeup {
    appId: string;
    revision: number;
}
export declare function parseSettingsRevisionWakeup(payload: string | undefined): SettingsRevisionWakeup | null;
/**
 * Wake source for the worker settings-revision listener. A subscriber is
 * invoked on every revision-change wakeup; the listener also polls on an
 * interval so a dropped NOTIFY is recovered. Injectable so unit tests drive
 * wakeups without a real Postgres connection.
 */
export interface SettingsRevisionWakeupSource {
    subscribe(listener: () => void): () => void;
    close(): Promise<void>;
}
/**
 * Notifier the desired-state writer calls after appending a revision. A failed
 * NOTIFY is logged, not thrown: the listener's poll fallback recovers a dropped
 * wakeup, so a revision is never blocked on notification delivery.
 */
export declare class PostgresSettingsRevisionNotifier {
    private readonly pool;
    private readonly logWarn?;
    constructor(pool: Pool, logWarn?: ((context: Record<string, unknown>, message: string) => void) | undefined);
    notifyRevisionChanged(input: SettingsRevisionWakeup): Promise<void>;
}
/**
 * Postgres LISTEN-backed wake source mirroring the runtime-event notifier and
 * the toolchain manifest wakeup source: a dedicated client LISTENs the settings
 * revision channel, and on connection failure it wakes subscribers (so the poll
 * fallback catches up) and reconnects with a fixed backoff. Stoppable via
 * {@link close}.
 */
export declare class PostgresSettingsRevisionWakeupSource implements SettingsRevisionWakeupSource {
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
