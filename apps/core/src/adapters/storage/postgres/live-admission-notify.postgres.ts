import type { Pool, PoolClient } from 'pg';

import type {
  LiveAdmissionWakeupSource,
  LiveAdmissionWorkItemNotifier,
} from '../../../domain/ports/live-turns.js';

export const LIVE_ADMISSION_CHANNEL = 'gantry_live_admissions';

const LISTEN_RECONNECT_DELAY_MS = 1_000;

export interface LiveAdmissionWakeup {
  appId: string;
  workItemId: string;
}

export class PostgresLiveAdmissionNotifier implements LiveAdmissionWorkItemNotifier {
  constructor(
    private readonly pool: Pool,
    private readonly logWarn?: (
      context: Record<string, unknown>,
      message: string,
    ) => void,
  ) {}

  async notifyLiveAdmissionWorkItem(input: LiveAdmissionWakeup): Promise<void> {
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [
        LIVE_ADMISSION_CHANNEL,
        '',
      ]);
    } catch (err) {
      this.logWarn?.(
        { err, appId: input.appId, workItemId: input.workItemId },
        'Failed to publish live admission wakeup; workers recover by durable replay',
      );
    }
  }
}

export class PostgresLiveAdmissionWakeupSource implements LiveAdmissionWakeupSource {
  private readonly listeners = new Set<() => void>();
  private clientPromise: Promise<PoolClient> | null = null;
  private client: PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly pool: Pool,
    private readonly logWarn?: (
      context: Record<string, unknown>,
      message: string,
    ) => void,
  ) {}

  subscribe(listener: () => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
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
    const client = this.client;
    if (!client) return;
    try {
      await client.query(`UNLISTEN ${LIVE_ADMISSION_CHANNEL}`);
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
        if (message.channel !== LIVE_ADMISSION_CHANNEL) return;
        this.wakeListeners();
      });
      client.on('error', (err) => {
        this.logWarn?.({ err }, 'Live admission LISTEN client failed');
        this.handleClientFailure(client!, err);
      });
      await client.query(`LISTEN ${LIVE_ADMISSION_CHANNEL}`);
    } catch (err) {
      this.logWarn?.({ err }, 'Failed to start live admission LISTEN client');
      if (client) this.releaseClient(client, err);
      this.client = null;
      this.clientPromise = null;
      this.wakeListeners();
      this.scheduleReconnect();
    } finally {
      if (!this.client) this.clientPromise = null;
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
    } catch {
      // Best effort during failure handling.
    }
  }

  private wakeListeners(): void {
    for (const listener of [...this.listeners]) listener();
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
