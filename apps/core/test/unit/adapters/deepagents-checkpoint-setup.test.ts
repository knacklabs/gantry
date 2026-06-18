import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMock = vi.hoisted(() => {
  class MockPool {
    static instances: MockPool[] = [];
    end = vi.fn(async () => undefined);

    constructor(readonly options: { connectionString: string; max: number }) {
      MockPool.instances.push(this);
    }
  }

  return { MockPool };
});

const postgresSaverMock = vi.hoisted(() => {
  class MockPostgresSaver {
    static instances: MockPostgresSaver[] = [];
    static setupImplementation: () => Promise<void> = async () => undefined;

    setup = vi.fn(() => MockPostgresSaver.setupImplementation());
    end = vi.fn(async () => undefined);

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

vi.mock('pg', () => ({
  default: { Pool: pgMock.MockPool },
  Pool: pgMock.MockPool,
}));

vi.mock(checkpointPostgresPackage, () => ({
  PostgresSaver: postgresSaverMock.MockPostgresSaver,
}));

import { ensureDeepAgentsCheckpointSchema } from '@core/adapters/llm/deepagents-langchain/checkpoint-setup.js';

beforeEach(() => {
  pgMock.MockPool.instances = [];
  postgresSaverMock.MockPostgresSaver.instances = [];
  postgresSaverMock.MockPostgresSaver.setupImplementation = async () =>
    undefined;
});

describe('ensureDeepAgentsCheckpointSchema', () => {
  it('runs official PostgresSaver schema setup with a one-connection setup pool', async () => {
    await ensureDeepAgentsCheckpointSchema({
      databaseUrl: 'postgres://gantry:test@localhost:5432/gantry_setup_one',
      schema: 'gantry_deepagents_setup_one',
    });

    expect(pgMock.MockPool.instances[0]?.options).toEqual({
      connectionString:
        'postgres://gantry:test@localhost:5432/gantry_setup_one',
      max: 1,
    });
    const saver = postgresSaverMock.MockPostgresSaver.instances[0];
    expect(saver?.pool).toBe(pgMock.MockPool.instances[0]);
    expect(saver?.serde).toBeUndefined();
    expect(saver?.options).toEqual({
      schema: 'gantry_deepagents_setup_one',
    });
    expect(saver?.setup).toHaveBeenCalledOnce();
    expect(saver?.end).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent setup for the same database and schema', async () => {
    let releaseSetup: (() => void) | undefined;
    postgresSaverMock.MockPostgresSaver.setupImplementation = () =>
      new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });

    const target = {
      databaseUrl: 'postgres://gantry:test@localhost:5432/gantry_setup_two',
      schema: 'gantry_deepagents_setup_two',
    };
    const first = ensureDeepAgentsCheckpointSchema(target);
    const second = ensureDeepAgentsCheckpointSchema(target);
    await Promise.resolve();

    expect(postgresSaverMock.MockPostgresSaver.instances).toHaveLength(1);
    releaseSetup?.();
    await Promise.all([first, second]);
    expect(
      postgresSaverMock.MockPostgresSaver.instances[0]?.setup,
    ).toHaveBeenCalledOnce();
  });
});
