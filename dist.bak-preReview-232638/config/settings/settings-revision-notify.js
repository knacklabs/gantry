/**
 * pg_notify channel the fleet settings desired-state writer publishes to and
 * worker revision listeners LISTEN on. Carried as a plain literal so publisher
 * and listener cannot drift (mirrors `gantry_runtime_dependencies`).
 */
export const SETTINGS_REVISION_CHANNEL = 'gantry_settings_revisions';
const LISTEN_RECONNECT_DELAY_MS = 1_000;
export function parseSettingsRevisionWakeup(payload) {
    if (!payload)
        return null;
    try {
        const parsed = JSON.parse(payload);
        if (typeof parsed.appId !== 'string' ||
            typeof parsed.revision !== 'number') {
            return null;
        }
        return { appId: parsed.appId, revision: parsed.revision };
    }
    catch {
        return null;
    }
}
/**
 * Notifier the desired-state writer calls after appending a revision. A failed
 * NOTIFY is logged, not thrown: the listener's poll fallback recovers a dropped
 * wakeup, so a revision is never blocked on notification delivery.
 */
export class PostgresSettingsRevisionNotifier {
    pool;
    logWarn;
    constructor(pool, logWarn) {
        this.pool = pool;
        this.logWarn = logWarn;
    }
    async notifyRevisionChanged(input) {
        const payload = JSON.stringify({
            appId: input.appId,
            revision: input.revision,
        });
        try {
            await this.pool.query('SELECT pg_notify($1, $2)', [
                SETTINGS_REVISION_CHANNEL,
                payload,
            ]);
        }
        catch (err) {
            this.logWarn?.({ err, appId: input.appId, revision: input.revision }, 'Failed to publish settings revision wakeup; listeners recover by poll');
        }
    }
}
/**
 * Postgres LISTEN-backed wake source mirroring the runtime-event notifier and
 * the toolchain manifest wakeup source: a dedicated client LISTENs the settings
 * revision channel, and on connection failure it wakes subscribers (so the poll
 * fallback catches up) and reconnects with a fixed backoff. Stoppable via
 * {@link close}.
 */
export class PostgresSettingsRevisionWakeupSource {
    pool;
    logWarn;
    listeners = new Set();
    clientPromise = null;
    client = null;
    reconnectTimer = null;
    closed = false;
    constructor(pool, logWarn) {
        this.pool = pool;
        this.logWarn = logWarn;
    }
    subscribe(listener) {
        if (this.closed)
            return () => { };
        this.listeners.add(listener);
        void this.ensureListening();
        return () => {
            this.listeners.delete(listener);
        };
    }
    async close() {
        this.closed = true;
        this.listeners.clear();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const client = this.client ?? (await this.clientPromise?.catch(() => null));
        if (!client)
            return;
        try {
            await client.query(`UNLISTEN ${SETTINGS_REVISION_CHANNEL}`);
        }
        finally {
            client.removeAllListeners('notification');
            client.removeAllListeners('error');
            client.release();
            this.client = null;
            this.clientPromise = null;
        }
    }
    async ensureListening() {
        if (this.client ||
            this.clientPromise ||
            this.closed ||
            this.listeners.size === 0) {
            return;
        }
        this.clientPromise = this.pool.connect();
        let client = null;
        try {
            client = await this.clientPromise;
            if (this.closed || this.listeners.size === 0) {
                client.release();
                return;
            }
            this.client = client;
            client.on('notification', (message) => {
                if (message.channel !== SETTINGS_REVISION_CHANNEL)
                    return;
                this.wakeListeners();
            });
            client.on('error', (err) => {
                this.logWarn?.({ err }, 'Settings revision LISTEN client failed');
                this.handleClientFailure(client, err);
            });
            await client.query(`LISTEN ${SETTINGS_REVISION_CHANNEL}`);
        }
        catch (err) {
            this.logWarn?.({ err }, 'Failed to start settings revision LISTEN client');
            if (client)
                this.releaseClient(client, err);
            this.client = null;
            this.clientPromise = null;
            this.wakeListeners();
            this.scheduleReconnect();
        }
        finally {
            if (!this.client)
                this.clientPromise = null;
        }
    }
    handleClientFailure(client, err) {
        if (this.client !== client)
            return;
        this.releaseClient(client, err);
        this.client = null;
        this.clientPromise = null;
        this.wakeListeners();
        this.scheduleReconnect();
    }
    releaseClient(client, err) {
        try {
            client.removeAllListeners('notification');
            client.removeAllListeners('error');
            client.release(err instanceof Error ? err : undefined);
        }
        catch {
            // Best effort during failure handling.
        }
    }
    wakeListeners() {
        for (const listener of [...this.listeners])
            listener();
    }
    scheduleReconnect() {
        if (this.closed ||
            this.listeners.size === 0 ||
            this.client ||
            this.clientPromise ||
            this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.ensureListening();
        }, LISTEN_RECONNECT_DELAY_MS);
        this.reconnectTimer.unref?.();
    }
}
