import type { Pool, PoolClient } from 'pg';

import type { RuntimeEventNotifier } from '../../../application/runtime-events/runtime-event-exchange.js';
import type {
  RuntimeEvent,
  RuntimeEventFilter,
} from '../../../domain/events/events.js';
import { runtimeEventMatchesFilter } from '../../../domain/events/runtime-event-filter.js';
import { logger } from '../../../infrastructure/logging/logger.js';

const RUNTIME_EVENTS_CHANNEL = 'myclaw_runtime_events';
const LISTEN_RECONNECT_DELAY_MS = 1_000;
const PG_NOTIFY_PAYLOAD_SAFE_BYTES = 7_500;

export interface RuntimeEventWakeup {
  eventId: RuntimeEvent['eventId'];
  appId: RuntimeEvent['appId'];
  sessionId?: RuntimeEvent['sessionId'];
  runId?: RuntimeEvent['runId'];
  jobId?: RuntimeEvent['jobId'];
  triggerId?: string;
  conversationId?: RuntimeEvent['conversationId'];
  threadId?: RuntimeEvent['threadId'];
  eventType: RuntimeEvent['eventType'];
}

function wakeupFromEvent(event: RuntimeEvent): RuntimeEventWakeup {
  return {
    eventId: event.eventId,
    appId: event.appId,
    sessionId: event.sessionId,
    runId: event.runId,
    jobId: event.jobId,
    triggerId: event.triggerId,
    conversationId: event.conversationId,
    threadId: event.threadId,
    eventType: event.eventType,
  };
}

export function parseRuntimeEventWakeup(
  payload: string | undefined,
): RuntimeEventWakeup | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<RuntimeEventWakeup>;
    if (
      typeof parsed.eventId !== 'number' ||
      typeof parsed.appId !== 'string'
    ) {
      return null;
    }
    if (typeof parsed.eventType !== 'string') return null;
    return parsed as RuntimeEventWakeup;
  } catch {
    return null;
  }
}

export class PostgresRuntimeEventNotifier implements RuntimeEventNotifier {
  private readonly listeners = new Map<
    () => void,
    RuntimeEventFilter | undefined
  >();
  private clientPromise: Promise<PoolClient> | null = null;
  private client: PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly pool: Pool) {}

  async notify(event: RuntimeEvent): Promise<void> {
    const fullPayload = JSON.stringify(wakeupFromEvent(event));
    const payload =
      Buffer.byteLength(fullPayload, 'utf8') <= PG_NOTIFY_PAYLOAD_SAFE_BYTES
        ? fullPayload
        : JSON.stringify({
            eventId: event.eventId,
            appId: event.appId,
            eventType: event.eventType,
          });
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [
        RUNTIME_EVENTS_CHANNEL,
        payload,
      ]);
    } catch (err) {
      logger.warn(
        { err, eventId: event.eventId, appId: event.appId },
        'Failed to publish runtime event wakeup; subscribers recover by cursor polling',
      );
    }
  }

  subscribe(listener: () => void, filter?: RuntimeEventFilter): () => void {
    if (this.closed) return () => {};
    this.listeners.set(listener, filter);
    void this.ensureListening();
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client ?? (await this.clientPromise?.catch(() => null));
    if (!client) return;
    try {
      await client.query(`UNLISTEN ${RUNTIME_EVENTS_CHANNEL}`);
    } finally {
      client.removeAllListeners('notification');
      client.removeAllListeners('error');
      client.release();
      this.client = null;
      this.clientPromise = null;
    }
  }

  private async ensureListening(): Promise<void> {
    if (
      this.client ||
      this.clientPromise ||
      this.closed ||
      this.listeners.size === 0
    ) {
      return;
    }
    this.clientPromise = this.pool.connect();
    let client: PoolClient | null = null;
    try {
      client = await this.clientPromise;
      if (this.closed || this.listeners.size === 0) {
        client.release();
        return;
      }
      this.client = client;
      client.on('notification', (message) => {
        if (message.channel !== RUNTIME_EVENTS_CHANNEL) return;
        const wakeup = parseRuntimeEventWakeup(message.payload);
        for (const [listener, filter] of [...this.listeners]) {
          if (wakeup && filter && !runtimeEventMatchesFilter(wakeup, filter)) {
            continue;
          }
          listener();
        }
      });
      client.on('error', (err) => {
        logger.warn({ err }, 'Runtime event LISTEN client failed');
        this.handleClientFailure(client!, err);
      });
      await client.query(`LISTEN ${RUNTIME_EVENTS_CHANNEL}`);
    } catch (err) {
      logger.warn({ err }, 'Failed to start runtime event LISTEN client');
      if (client) this.releaseClient(client, err);
      this.client = null;
      this.clientPromise = null;
      this.wakeListeners();
      this.scheduleReconnect();
    } finally {
      if (!this.client) {
        this.clientPromise = null;
      }
    }
  }

  private handleClientFailure(client: PoolClient, err: Error): void {
    if (this.client !== client) return;
    this.releaseClient(client, err);
    this.client = null;
    this.clientPromise = null;
    this.wakeListeners();
    this.scheduleReconnect();
  }

  private releaseClient(client: PoolClient, err?: unknown): void {
    try {
      client.removeAllListeners('notification');
      client.removeAllListeners('error');
      client.release(err instanceof Error ? err : undefined);
    } catch {}
  }

  private wakeListeners(): void {
    for (const listener of [...this.listeners.keys()]) {
      listener();
    }
  }

  private scheduleReconnect(): void {
    if (
      this.closed ||
      this.listeners.size === 0 ||
      this.client ||
      this.clientPromise ||
      this.reconnectTimer
    ) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureListening();
    }, LISTEN_RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }
}
