import { runtimeEventMatchesFilter } from '../../../domain/events/runtime-event-filter.js';
import { logger } from '../../../infrastructure/logging/logger.js';
const RUNTIME_EVENTS_CHANNEL = 'gantry_runtime_events';
const LISTEN_RECONNECT_DELAY_MS = 1_000;
const PG_NOTIFY_PAYLOAD_SAFE_BYTES = 7_500;
function wakeupFromEvent(event) {
    return {
        eventId: event.eventId,
        appId: event.appId,
        complete: true,
        sessionId: event.sessionId,
        runId: event.runId,
        jobId: event.jobId,
        triggerId: event.triggerId,
        conversationId: event.conversationId,
        threadId: event.threadId,
        eventType: event.eventType,
    };
}
export function parseRuntimeEventWakeup(payload) {
    if (!payload)
        return null;
    try {
        const parsed = JSON.parse(payload);
        if (typeof parsed.eventId !== 'number' ||
            typeof parsed.appId !== 'string') {
            return null;
        }
        if (typeof parsed.eventType !== 'string')
            return null;
        return {
            ...parsed,
            complete: parsed.complete === true,
        };
    }
    catch {
        return null;
    }
}
function wakeupShouldNotifyFilter(wakeup, filter) {
    if (wakeup.appId !== filter.appId)
        return false;
    if (filter.afterEventId !== undefined &&
        wakeup.eventId <= filter.afterEventId) {
        return false;
    }
    if (filter.eventTypes?.length &&
        !filter.eventTypes.includes(wakeup.eventType)) {
        return false;
    }
    if (!wakeup.complete) {
        return true;
    }
    return runtimeEventMatchesFilter(wakeup, filter);
}
export class PostgresRuntimeEventNotifier {
    pool;
    listeners = new Map();
    clientPromise = null;
    client = null;
    reconnectTimer = null;
    closed = false;
    constructor(pool) {
        this.pool = pool;
    }
    async notify(event) {
        const fullPayload = JSON.stringify(wakeupFromEvent(event));
        const payload = Buffer.byteLength(fullPayload, 'utf8') <= PG_NOTIFY_PAYLOAD_SAFE_BYTES
            ? fullPayload
            : JSON.stringify({
                eventId: event.eventId,
                appId: event.appId,
                complete: false,
                eventType: event.eventType,
            });
        try {
            await this.pool.query('SELECT pg_notify($1, $2)', [
                RUNTIME_EVENTS_CHANNEL,
                payload,
            ]);
        }
        catch (err) {
            logger.warn({ err, eventId: event.eventId, appId: event.appId }, 'Failed to publish runtime event wakeup; subscribers recover by cursor polling');
        }
    }
    subscribe(listener, filter) {
        if (this.closed)
            return () => { };
        this.listeners.set(listener, filter);
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
            await client.query(`UNLISTEN ${RUNTIME_EVENTS_CHANNEL}`);
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
                if (message.channel !== RUNTIME_EVENTS_CHANNEL)
                    return;
                const wakeup = parseRuntimeEventWakeup(message.payload);
                for (const [listener, filter] of [...this.listeners]) {
                    if (wakeup && filter && !wakeupShouldNotifyFilter(wakeup, filter)) {
                        continue;
                    }
                    listener();
                }
            });
            client.on('error', (err) => {
                logger.warn({ err }, 'Runtime event LISTEN client failed');
                this.handleClientFailure(client, err);
            });
            await client.query(`LISTEN ${RUNTIME_EVENTS_CHANNEL}`);
        }
        catch (err) {
            logger.warn({ err }, 'Failed to start runtime event LISTEN client');
            if (client)
                this.releaseClient(client, err);
            this.client = null;
            this.clientPromise = null;
            this.wakeListeners();
            this.scheduleReconnect();
        }
        finally {
            if (!this.client) {
                this.clientPromise = null;
            }
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
            // Best effort release during connection failure handling.
        }
    }
    wakeListeners() {
        for (const listener of [...this.listeners.keys()]) {
            listener();
        }
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
