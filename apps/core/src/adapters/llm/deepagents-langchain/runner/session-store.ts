import { randomUUID } from 'node:crypto';
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
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: RUNNER_CHECKPOINT_POOL_MAX_CONNECTIONS,
    });
    return instrumentCheckpointSaver(
      new PostgresSaver(pool, undefined, { schema }),
      this.timing,
    );
  }
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
