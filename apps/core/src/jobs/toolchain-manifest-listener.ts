import type { Pool, PoolClient } from 'pg';

import { TOOLCHAIN_MANIFEST_CHANNEL } from './toolchain-manifest-notify.js';

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

const LISTEN_RECONNECT_DELAY_MS = 1_000;

/**
 * Postgres LISTEN-backed wake source mirroring the runtime-event notifier's
 * reconnect pattern: a dedicated client LISTENs the manifest channel, and on
 * connection failure it wakes subscribers (so the poll fallback catches up) and
 * reconnects with a fixed backoff. Stoppable via {@link close}.
 */
export class PostgresManifestWakeupSource implements ManifestWakeupSource {
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
    const client = this.client ?? (await this.clientPromise?.catch(() => null));
    if (!client) return;
    try {
      await client.query(`UNLISTEN ${TOOLCHAIN_MANIFEST_CHANNEL}`);
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
        if (message.channel !== TOOLCHAIN_MANIFEST_CHANNEL) return;
        this.wakeListeners();
      });
      client.on('error', (err) => {
        this.logWarn?.({ err }, 'Toolchain manifest LISTEN client failed');
        this.handleClientFailure(client!, err);
      });
      await client.query(`LISTEN ${TOOLCHAIN_MANIFEST_CHANNEL}`);
    } catch (err) {
      this.logWarn?.(
        { err },
        'Failed to start toolchain manifest LISTEN client',
      );
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
