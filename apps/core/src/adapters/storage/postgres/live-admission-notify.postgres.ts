import type { Pool, PoolClient } from 'pg';

import type {
  LiveAdmissionWakeupSource,
  LiveAdmissionWorkItemNotifier,
  LiveTurnCommandNotifier,
  LiveTurnCommandWakeupSource,
} from '../../../domain/ports/live-turns.js';

export const LIVE_ADMISSION_CHANNEL = 'gantry_live_admissions';
export const LIVE_TURN_COMMAND_CHANNEL = 'gantry_live_turn_commands';

const LISTEN_RECONNECT_DELAY_MS = 1_000;

export function isLiveWakeupListenEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.GANTRY_LIVE_WAKEUP_LISTEN_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(
    'GANTRY_LIVE_WAKEUP_LISTEN_ENABLED must be true, false, 1, or 0.',
  );
}

/**
 * Connection-free wake sources for constrained fleets. Live admission already
 * polls durable work every two seconds, and active live turns poll their
 * command inbox every second, so LISTEN is only a latency optimization.
 */
export class PollingLiveAdmissionWakeupSource implements LiveAdmissionWakeupSource {
  subscribe(_listener: () => void): () => void {
    return () => {};
  }

  async close(): Promise<void> {}
}

export class PollingLiveTurnCommandWakeupSource implements LiveTurnCommandWakeupSource {
  subscribe(_listener: () => void): () => void {
    return () => {};
  }

  async close(): Promise<void> {}
}

export interface LiveAdmissionWakeup {
  appId: string;
  workItemId: string;
}

export interface LiveTurnCommandWakeup {
  liveTurnId: string;
  commandId: string;
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

export class PostgresLiveTurnCommandNotifier implements LiveTurnCommandNotifier {
  constructor(
    private readonly pool: Pool,
    private readonly logWarn?: (
      context: Record<string, unknown>,
      message: string,
    ) => void,
  ) {}

  async notifyLiveTurnCommand(input: LiveTurnCommandWakeup): Promise<void> {
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [
        LIVE_TURN_COMMAND_CHANNEL,
        '',
      ]);
    } catch (err) {
      this.logWarn?.(
        { err, liveTurnId: input.liveTurnId, commandId: input.commandId },
        'Failed to publish live-turn command wakeup; owner recovers by durable command replay',
      );
    }
  }
}

class PostgresWakeupSource {
  private readonly listeners = new Set<() => void>();
  private clientPromise: Promise<PoolClient> | null = null;
  private client: PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly pool: Pool,
    private readonly channel: string,
    private readonly listenFailureMessage: string,
    private readonly listenStartFailureMessage: string,
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
      await client.query(`UNLISTEN ${this.channel}`);
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
        if (message.channel !== this.channel) return;
        this.wakeListeners();
      });
      client.on('error', (err) => {
        this.logWarn?.({ err }, this.listenFailureMessage);
        this.handleClientFailure(client!, err);
      });
      await client.query(`LISTEN ${this.channel}`);
    } catch (err) {
      this.logWarn?.({ err }, this.listenStartFailureMessage);
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

export class PostgresLiveAdmissionWakeupSource implements LiveAdmissionWakeupSource {
  private readonly source: PostgresWakeupSource;

  constructor(
    pool: Pool,
    logWarn?: (context: Record<string, unknown>, message: string) => void,
  ) {
    this.source = new PostgresWakeupSource(
      pool,
      LIVE_ADMISSION_CHANNEL,
      'Live admission LISTEN client failed',
      'Failed to start live admission LISTEN client',
      logWarn,
    );
  }

  subscribe(listener: () => void): () => void {
    return this.source.subscribe(listener);
  }

  close(): Promise<void> {
    return this.source.close();
  }
}

export class PostgresLiveTurnCommandWakeupSource implements LiveTurnCommandWakeupSource {
  private readonly source: PostgresWakeupSource;

  constructor(
    pool: Pool,
    logWarn?: (context: Record<string, unknown>, message: string) => void,
  ) {
    this.source = new PostgresWakeupSource(
      pool,
      LIVE_TURN_COMMAND_CHANNEL,
      'Live-turn command LISTEN client failed',
      'Failed to start live-turn command LISTEN client',
      logWarn,
    );
  }

  subscribe(listener: () => void): () => void {
    return this.source.subscribe(listener);
  }

  close(): Promise<void> {
    return this.source.close();
  }
}
