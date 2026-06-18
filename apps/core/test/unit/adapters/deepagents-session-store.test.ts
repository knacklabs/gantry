import { beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';

const pgMock = vi.hoisted(() => {
  class MockPool {
    static instances: MockPool[] = [];
    end = vi.fn(async () => undefined);

    constructor(readonly options: Record<string, unknown>) {
      MockPool.instances.push(this);
    }
  }

  return { MockPool };
});

const postgresSaverMock = vi.hoisted(() => {
  type Tuple = { checkpoint: { id: string } };
  class MockPostgresSaver {
    static nextTuple: Tuple | undefined = {
      checkpoint: { id: 'checkpoint-1' },
    };
    static getTupleImplementation: () => Promise<Tuple | undefined> =
      async () => MockPostgresSaver.nextTuple;
    static putImplementation: () => Promise<{
      configurable: { thread_id: string };
    }> = async () => ({
      configurable: { thread_id: 'session-123' },
    });
    static putWritesImplementation: () => Promise<void> = async () => undefined;
    static instances: MockPostgresSaver[] = [];

    end = vi.fn(async () => undefined);
    getTuple = vi.fn(() => MockPostgresSaver.getTupleImplementation());
    put = vi.fn(() => MockPostgresSaver.putImplementation());
    putWrites = vi.fn(() => MockPostgresSaver.putWritesImplementation());

    constructor(
      readonly pool: unknown,
      readonly serde?: unknown,
      readonly options?: { schema?: string },
    ) {
      MockPostgresSaver.instances.push(this);
    }
  }

  return { MockPostgresSaver };
});

const checkpointPostgresPackage = vi.hoisted(() =>
  ['@langchain', 'langgraph-checkpoint-postgres'].join('/'),
);

vi.mock(checkpointPostgresPackage, () => ({
  PostgresSaver: postgresSaverMock.MockPostgresSaver,
}));

vi.mock('pg', () => ({
  default: { Pool: pgMock.MockPool },
  Pool: pgMock.MockPool,
}));

import {
  createDeepAgentCheckpointTiming,
  DeepAgentSessionStore,
  isMissingDeepAgentSessionError,
  MISSING_DEEPAGENTS_SESSION_MARKER,
} from '@core/adapters/llm/deepagents-langchain/runner/session-store.js';

const checkpointConfig = {
  databaseUrl: 'postgres://gantry_app:secret@localhost:5432/gantry',
  schema: 'gantry_deepagents',
};

beforeEach(() => {
  postgresSaverMock.MockPostgresSaver.nextTuple = {
    checkpoint: { id: 'checkpoint-1' },
  };
  postgresSaverMock.MockPostgresSaver.getTupleImplementation = async () =>
    postgresSaverMock.MockPostgresSaver.nextTuple;
  postgresSaverMock.MockPostgresSaver.putImplementation = async () => ({
    configurable: { thread_id: 'session-123' },
  });
  postgresSaverMock.MockPostgresSaver.putWritesImplementation = async () =>
    undefined;
  postgresSaverMock.MockPostgresSaver.instances = [];
  pgMock.MockPool.instances = [];
});

describe('DeepAgentSessionStore', () => {
  it('creates an official PostgresSaver without runner-local schema setup', async () => {
    const store = new DeepAgentSessionStore(checkpointConfig);
    const sessionId = store.newSessionId();

    const saver = await store.create(sessionId);

    expect(pgMock.MockPool.instances[0]?.options).toEqual({
      connectionString: checkpointConfig.databaseUrl,
      max: 1,
    });
    expect(saver.pool).toBe(pgMock.MockPool.instances[0]);
    expect(saver.serde).toBeUndefined();
    expect(saver.options).toEqual({ schema: checkpointConfig.schema });
    expect(saver.getTuple).not.toHaveBeenCalled();
  });

  it('opens proxied checkpointer streams with HTTP CONNECT', async () => {
    let connectRequest = '';
    const proxy = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        connectRequest = chunk.toString('latin1');
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') {
      throw new Error('proxy did not bind a TCP port');
    }
    try {
      const store = new DeepAgentSessionStore({
        ...checkpointConfig,
        proxyUrl: `http://127.0.0.1:${address.port}/`,
      });
      await store.create('session-123');
      const options = pgMock.MockPool.instances[0]?.options as {
        stream?: () => {
          connect: (port: number, host: string) => void;
          destroy: () => void;
          once: (event: string, listener: (...args: unknown[]) => void) => void;
        };
      };
      const stream = options.stream?.();
      if (!stream) throw new Error('expected proxied stream');
      await new Promise<void>((resolve, reject) => {
        stream.once('connect', resolve);
        stream.once('error', reject);
        stream.connect(6543, 'db.internal');
      });

      expect(connectRequest).toContain('CONNECT db.internal:6543 HTTP/1.1');
      expect(connectRequest).toContain('Host: db.internal:6543');
      stream?.destroy();
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('loads a resumed session only when the checkpoint thread exists', async () => {
    const store = new DeepAgentSessionStore(checkpointConfig);

    const saver = await store.load('session-123');

    expect(saver.getTuple).toHaveBeenCalledWith({
      configurable: { thread_id: 'session-123' },
    });
  });

  it('records official saver load and write timing without replacing the saver', async () => {
    let now = 100;
    postgresSaverMock.MockPostgresSaver.getTupleImplementation = async () => {
      now += 7;
      return postgresSaverMock.MockPostgresSaver.nextTuple;
    };
    postgresSaverMock.MockPostgresSaver.putImplementation = async () => {
      now += 11;
      return { configurable: { thread_id: 'session-123' } };
    };
    postgresSaverMock.MockPostgresSaver.putWritesImplementation = async () => {
      now += 13;
    };
    const timing = createDeepAgentCheckpointTiming({ nowMs: () => now });
    const store = new DeepAgentSessionStore(checkpointConfig, timing);

    const saver = await store.load('session-123');
    await saver.put(
      { configurable: { thread_id: 'session-123' } },
      {
        v: 4,
        ts: new Date(0).toISOString(),
        id: 'checkpoint-1',
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
        pending_sends: [],
      },
      {},
      {},
    );
    await saver.putWrites(
      { configurable: { thread_id: 'session-123' } },
      [],
      'task-1',
    );

    expect(saver).toBe(postgresSaverMock.MockPostgresSaver.instances[0]);
    expect(timing.snapshot()).toEqual({
      loadCount: 1,
      loadMs: 7,
      maxLoadMs: 7,
      writeCount: 2,
      writeMs: 24,
      maxWriteMs: 13,
    });
  });

  it('throws a missing-session marker and closes the pool when no checkpoint exists', async () => {
    postgresSaverMock.MockPostgresSaver.nextTuple = undefined;
    const store = new DeepAgentSessionStore(checkpointConfig);

    await expect(store.load('missing-session')).rejects.toThrow(
      MISSING_DEEPAGENTS_SESSION_MARKER,
    );
    expect(
      postgresSaverMock.MockPostgresSaver.instances[0]?.end,
    ).toHaveBeenCalledOnce();
  });

  it('treats a checkpoint stored under another thread as missing for the requested session', async () => {
    const store = new DeepAgentSessionStore(checkpointConfig);
    postgresSaverMock.MockPostgresSaver.getTupleImplementation = async () =>
      undefined;

    await expect(store.load('requested-session')).rejects.toThrow(
      `${MISSING_DEEPAGENTS_SESSION_MARKER}: requested-session`,
    );
    expect(
      postgresSaverMock.MockPostgresSaver.instances[0]?.getTuple,
    ).toHaveBeenCalledWith({
      configurable: { thread_id: 'requested-session' },
    });
    expect(
      postgresSaverMock.MockPostgresSaver.instances[0]?.end,
    ).toHaveBeenCalledOnce();
  });

  it('propagates corrupt checkpoint load failures and closes the pool', async () => {
    const corrupt = new Error('Unexpected token in checkpoint blob');
    postgresSaverMock.MockPostgresSaver.getTupleImplementation = async () => {
      throw corrupt;
    };
    const store = new DeepAgentSessionStore(checkpointConfig);

    await expect(store.load('corrupt-session')).rejects.toThrow(
      'Unexpected token in checkpoint blob',
    );
    expect(
      postgresSaverMock.MockPostgresSaver.instances[0]?.getTuple,
    ).toHaveBeenCalledWith({
      configurable: { thread_id: 'corrupt-session' },
    });
    expect(
      postgresSaverMock.MockPostgresSaver.instances[0]?.end,
    ).toHaveBeenCalledOnce();
  });

  it('propagates unauthorized checkpoint load failures and closes the pool', async () => {
    const unauthorized = new Error(
      'permission denied for schema gantry_deepagents',
    );
    postgresSaverMock.MockPostgresSaver.getTupleImplementation = async () => {
      throw unauthorized;
    };
    const store = new DeepAgentSessionStore(checkpointConfig);

    await expect(store.load('unauthorized-session')).rejects.toThrow(
      'permission denied for schema gantry_deepagents',
    );
    expect(
      postgresSaverMock.MockPostgresSaver.instances[0]?.end,
    ).toHaveBeenCalledOnce();
  });

  it('rejects invalid session ids before touching Postgres', async () => {
    const store = new DeepAgentSessionStore(checkpointConfig);

    await expect(store.load('../bad')).rejects.toThrow('invalid id');
    expect(pgMock.MockPool.instances).toHaveLength(0);
  });

  it('classifies missing-session errors for host stale-session retry', () => {
    expect(
      isMissingDeepAgentSessionError(
        `${MISSING_DEEPAGENTS_SESSION_MARKER}: abc`,
      ),
    ).toBe(true);
    expect(isMissingDeepAgentSessionError('some upstream error')).toBe(false);
  });
});
