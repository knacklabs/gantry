export const LIVE_ADMISSION_CHANNEL = 'gantry_live_admissions';
export const LIVE_TURN_COMMAND_CHANNEL = 'gantry_live_turn_commands';
const LISTEN_RECONNECT_DELAY_MS = 1_000;
export class PostgresLiveAdmissionNotifier {
    pool;
    logWarn;
    constructor(pool, logWarn) {
        this.pool = pool;
        this.logWarn = logWarn;
    }
    async notifyLiveAdmissionWorkItem(input) {
        try {
            await this.pool.query('SELECT pg_notify($1, $2)', [
                LIVE_ADMISSION_CHANNEL,
                '',
            ]);
        }
        catch (err) {
            this.logWarn?.({ err, appId: input.appId, workItemId: input.workItemId }, 'Failed to publish live admission wakeup; workers recover by durable replay');
        }
    }
}
export class PostgresLiveTurnCommandNotifier {
    pool;
    logWarn;
    constructor(pool, logWarn) {
        this.pool = pool;
        this.logWarn = logWarn;
    }
    async notifyLiveTurnCommand(input) {
        try {
            await this.pool.query('SELECT pg_notify($1, $2)', [
                LIVE_TURN_COMMAND_CHANNEL,
                '',
            ]);
        }
        catch (err) {
            this.logWarn?.({ err, liveTurnId: input.liveTurnId, commandId: input.commandId }, 'Failed to publish live-turn command wakeup; owner recovers by durable command replay');
        }
    }
}
class PostgresWakeupSource {
    pool;
    channel;
    listenFailureMessage;
    listenStartFailureMessage;
    logWarn;
    listeners = new Set();
    clientPromise = null;
    client = null;
    reconnectTimer = null;
    closed = false;
    constructor(pool, channel, listenFailureMessage, listenStartFailureMessage, logWarn) {
        this.pool = pool;
        this.channel = channel;
        this.listenFailureMessage = listenFailureMessage;
        this.listenStartFailureMessage = listenStartFailureMessage;
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
        const client = this.client;
        if (!client)
            return;
        try {
            await client.query(`UNLISTEN ${this.channel}`);
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
                if (message.channel !== this.channel)
                    return;
                this.wakeListeners();
            });
            client.on('error', (err) => {
                this.logWarn?.({ err }, this.listenFailureMessage);
                this.handleClientFailure(client, err);
            });
            await client.query(`LISTEN ${this.channel}`);
        }
        catch (err) {
            this.logWarn?.({ err }, this.listenStartFailureMessage);
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
export class PostgresLiveAdmissionWakeupSource {
    source;
    constructor(pool, logWarn) {
        this.source = new PostgresWakeupSource(pool, LIVE_ADMISSION_CHANNEL, 'Live admission LISTEN client failed', 'Failed to start live admission LISTEN client', logWarn);
    }
    subscribe(listener) {
        return this.source.subscribe(listener);
    }
    close() {
        return this.source.close();
    }
}
export class PostgresLiveTurnCommandWakeupSource {
    source;
    constructor(pool, logWarn) {
        this.source = new PostgresWakeupSource(pool, LIVE_TURN_COMMAND_CHANNEL, 'Live-turn command LISTEN client failed', 'Failed to start live-turn command LISTEN client', logWarn);
    }
    subscribe(listener) {
        return this.source.subscribe(listener);
    }
    close() {
        return this.source.close();
    }
}
