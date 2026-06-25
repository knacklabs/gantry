import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { Duplex } from 'node:stream';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

// Adapter-private session projection for live (interactive) DeepAgents turns.
// Durable provider-session ownership stays Gantry-owned (AgentSession). This
// runner uses LangGraph's official Postgres checkpointer keyed by the Gantry
// provider session id (`thread_id=sessionId`), instead of replaying transcript
// messages or maintaining a custom file-backed checkpoint implementation.
//
// Scheduled jobs are ephemeral and never touch this store. A missing checkpoint
// for a resumed live session throws MISSING_DEEPAGENTS_SESSION so the host can
// expire the stale provider session and retry fresh on the same provider.

export const MISSING_DEEPAGENTS_SESSION_MARKER =
  'No DeepAgents session found with session ID';

export interface DeepAgentCheckpointerConfig {
  databaseUrl: string;
  schema: string;
  proxyUrl?: string;
}

export type DeepAgentCheckpointSaver = PostgresSaver;

export interface DeepAgentCheckpointTimingSnapshot {
  loadCount: number;
  loadMs: number;
  maxLoadMs?: number;
  writeCount: number;
  writeMs: number;
  maxWriteMs?: number;
}

export interface DeepAgentCheckpointTiming {
  measureLoad: <T>(work: () => Promise<T>) => Promise<T>;
  measureWrite: <T>(work: () => Promise<T>) => Promise<T>;
  snapshot: () => DeepAgentCheckpointTimingSnapshot;
}

const RUNNER_CHECKPOINT_POOL_MAX_CONNECTIONS = 1;

export class DeepAgentSessionStore {
  constructor(
    private readonly config: DeepAgentCheckpointerConfig,
    private readonly timing?: DeepAgentCheckpointTiming,
  ) {}

  static newSessionId(): string {
    return randomUUID();
  }

  newSessionId(): string {
    return DeepAgentSessionStore.newSessionId();
  }

  async create(sessionId: string): Promise<DeepAgentCheckpointSaver> {
    assertSessionId(sessionId);
    return this.openSaver();
  }

  async load(sessionId: string): Promise<DeepAgentCheckpointSaver> {
    assertSessionId(sessionId);
    const saver = await this.openSaver();
    let tuple: Awaited<ReturnType<DeepAgentCheckpointSaver['getTuple']>>;
    try {
      tuple = await saver.getTuple({
        configurable: { thread_id: sessionId },
      });
    } catch (error) {
      await saver.end().catch(() => {});
      throw error;
    }
    if (!tuple) {
      await saver.end().catch(() => {});
      throw new Error(`${MISSING_DEEPAGENTS_SESSION_MARKER}: ${sessionId}`);
    }
    return saver;
  }

  private async openSaver(): Promise<DeepAgentCheckpointSaver> {
    const databaseUrl = this.config.databaseUrl.trim();
    const schema = this.config.schema.trim();
    if (!databaseUrl || !schema) {
      throw new Error(
        'DeepAgents runner is missing Postgres checkpointer configuration for live session persistence.',
      );
    }
    const poolConfig: pg.PoolConfig = {
      connectionString: databaseUrl,
      max: RUNNER_CHECKPOINT_POOL_MAX_CONNECTIONS,
    };
    const proxyUrl = deepAgentCheckpointerProxyUrl(this.config.proxyUrl);
    if (proxyUrl) {
      // pg uses this factory instead of opening databaseUrl directly, so
      // sandboxed runners reach private Postgres only through Gantry egress.
      poolConfig.stream = () => new HttpConnectPostgresStream(proxyUrl);
    }
    const pool = new pg.Pool(poolConfig);
    return createDeepAgentCheckpointSaverFromPool(pool, schema, this.timing);
  }
}

class HttpConnectPostgresStream extends Duplex {
  private readonly socket = new net.Socket();
  private proxyBuffer = Buffer.alloc(0);
  private connectedToTarget = false;
  private connectCallback: (() => void) | undefined;
  private readonly pendingWrites: Array<{
    chunk: Buffer;
    callback: (error?: Error | null) => void;
  }> = [];

  constructor(proxyUrl: string) {
    super();
    const proxy = parseHttpProxyUrl(proxyUrl);
    this.socket.on('error', (error) => this.destroy(error));
    this.socket.on('end', () => this.push(null));
    this.socket.on('close', () => this.emit('close'));
    this.socket.once('connect', () => {
      this.socket.write(
        [
          `CONNECT ${this.targetAuthority} HTTP/1.1`,
          `Host: ${this.targetAuthority}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    this.proxyHost = proxy.hostname;
    this.proxyPort = Number(proxy.port || '80');
  }

  private readonly proxyHost: string;
  private readonly proxyPort: number;
  private targetAuthority = '';

  connect(
    portOrPath: number | string,
    hostOrCallback?: string | (() => void),
    callback?: () => void,
  ): this {
    if (typeof portOrPath !== 'number') {
      this.destroy(new Error('Postgres proxy stream requires TCP host/port.'));
      return this;
    }
    const host =
      typeof hostOrCallback === 'string' ? hostOrCallback : 'localhost';
    this.connectCallback =
      typeof hostOrCallback === 'function' ? hostOrCallback : callback;
    this.targetAuthority = postgresAuthority(host, portOrPath);
    this.socket.on('data', this.handleProxyData);
    this.socket.connect(this.proxyPort, this.proxyHost);
    return this;
  }

  setNoDelay(noDelay?: boolean): this {
    this.socket.setNoDelay(noDelay);
    return this;
  }

  setKeepAlive(enable?: boolean, initialDelay?: number): this {
    this.socket.setKeepAlive(enable, initialDelay);
    return this;
  }

  ref(): this {
    this.socket.ref();
    return this;
  }

  unref(): this {
    this.socket.unref();
    return this;
  }

  _read(): void {
    this.socket.resume();
  }

  _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.connectedToTarget) {
      this.pendingWrites.push({
        chunk: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding),
        callback,
      });
      return;
    }
    this.socket.write(chunk, encoding, callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    this.socket.end(callback);
  }

  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.socket.destroy(error ?? undefined);
    callback(error);
  }

  private readonly handleProxyData = (chunk: Buffer): void => {
    this.proxyBuffer = Buffer.concat([this.proxyBuffer, chunk]);
    const headerEnd = this.proxyBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (this.proxyBuffer.length > 8192) {
        this.destroy(
          new Error('Postgres proxy CONNECT response is too large.'),
        );
      }
      return;
    }
    const header = this.proxyBuffer.subarray(0, headerEnd).toString('latin1');
    const firstLine = header.split('\r\n')[0] ?? '';
    if (!/^HTTP\/1\.[01] 2\d\d(?:\s|$)/.test(firstLine)) {
      this.destroy(new Error(`Postgres proxy CONNECT failed: ${firstLine}`));
      return;
    }
    const rest = this.proxyBuffer.subarray(headerEnd + 4);
    this.proxyBuffer = Buffer.alloc(0);
    this.socket.off('data', this.handleProxyData);
    this.socket.on('data', this.forwardData);
    this.connectedToTarget = true;
    this.emit('connect');
    this.connectCallback?.();
    this.flushPendingWrites();
    if (rest.length > 0) this.forwardData(rest);
  };

  private readonly forwardData = (chunk: Buffer): void => {
    if (!this.push(chunk)) this.socket.pause();
  };

  private flushPendingWrites(): void {
    for (const pending of this.pendingWrites.splice(0)) {
      this.socket.write(pending.chunk, pending.callback);
    }
  }
}

function parseHttpProxyUrl(value: string): URL {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'http:' ||
    !parsed.port ||
    (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')
  ) {
    throw new Error(
      'DeepAgents checkpointer proxy must be a loopback http URL.',
    );
  }
  return parsed;
}

function deepAgentCheckpointerProxyUrl(
  configured: string | undefined,
): string | undefined {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  if (process.env.GANTRY_SANDBOX_RUNTIME_PROXY !== '1') return undefined;
  return (
    process.env.HTTP_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    process.env.https_proxy?.trim() ||
    undefined
  );
}

function postgresAuthority(host: string, port: number): string {
  const normalizedHost = host.replace(/^\[|\]$/g, '');
  const authorityHost = normalizedHost.includes(':')
    ? `[${normalizedHost}]`
    : normalizedHost;
  return `${authorityHost}:${port}`;
}

export function createDeepAgentCheckpointSaverFromPool(
  pool: pg.Pool,
  schema: string,
  timing?: DeepAgentCheckpointTiming,
): DeepAgentCheckpointSaver {
  return instrumentCheckpointSaver(
    new PostgresSaver(pool, undefined, { schema }),
    timing,
  );
}

export function isMissingDeepAgentSessionError(
  error: string | undefined,
): boolean {
  return new RegExp(MISSING_DEEPAGENTS_SESSION_MARKER, 'i').test(error ?? '');
}

function assertSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(
      `${MISSING_DEEPAGENTS_SESSION_MARKER}: ${sessionId} (invalid id)`,
    );
  }
}

export function createDeepAgentCheckpointTiming(input: {
  nowMs: () => number;
}): DeepAgentCheckpointTiming {
  let loadCount = 0;
  let loadMs = 0;
  let maxLoadMs: number | undefined;
  let writeCount = 0;
  let writeMs = 0;
  let maxWriteMs: number | undefined;

  const elapsedSince = (since: number) =>
    Math.max(0, Math.round(input.nowMs() - since));
  const record = (kind: 'load' | 'write', elapsedMs: number): void => {
    if (kind === 'load') {
      loadCount += 1;
      loadMs += elapsedMs;
      maxLoadMs = Math.max(maxLoadMs ?? 0, elapsedMs);
      return;
    }
    writeCount += 1;
    writeMs += elapsedMs;
    maxWriteMs = Math.max(maxWriteMs ?? 0, elapsedMs);
  };

  return {
    async measureLoad<T>(work: () => Promise<T>): Promise<T> {
      const startedAt = input.nowMs();
      try {
        return await work();
      } finally {
        record('load', elapsedSince(startedAt));
      }
    },
    async measureWrite<T>(work: () => Promise<T>): Promise<T> {
      const startedAt = input.nowMs();
      try {
        return await work();
      } finally {
        record('write', elapsedSince(startedAt));
      }
    },
    snapshot(): DeepAgentCheckpointTimingSnapshot {
      return {
        loadCount,
        loadMs,
        ...(maxLoadMs !== undefined ? { maxLoadMs } : {}),
        writeCount,
        writeMs,
        ...(maxWriteMs !== undefined ? { maxWriteMs } : {}),
      };
    },
  };
}

function instrumentCheckpointSaver(
  saver: DeepAgentCheckpointSaver,
  timing: DeepAgentCheckpointTiming | undefined,
): DeepAgentCheckpointSaver {
  if (!timing) return saver;

  const originalGetTuple = saver.getTuple.bind(saver);
  saver.getTuple = ((
    ...args: Parameters<DeepAgentCheckpointSaver['getTuple']>
  ) =>
    timing.measureLoad(() =>
      originalGetTuple(...args),
    )) as DeepAgentCheckpointSaver['getTuple'];

  const originalPut = saver.put.bind(saver);
  saver.put = ((...args: Parameters<DeepAgentCheckpointSaver['put']>) =>
    timing.measureWrite(() =>
      originalPut(...args),
    )) as DeepAgentCheckpointSaver['put'];

  const originalPutWrites = saver.putWrites.bind(saver);
  saver.putWrites = ((
    ...args: Parameters<DeepAgentCheckpointSaver['putWrites']>
  ) =>
    timing.measureWrite(() =>
      originalPutWrites(...args),
    )) as DeepAgentCheckpointSaver['putWrites'];

  return saver;
}
