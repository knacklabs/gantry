import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import {
  createDeepAgentCheckpointTiming,
  DeepAgentSessionStore,
  MISSING_DEEPAGENTS_SESSION_MARKER,
} from '@core/adapters/llm/deepagents-langchain/runner/session-store.js';
import { ensureDeepAgentsCheckpointSchema } from '@core/adapters/llm/deepagents-langchain/checkpoint-setup.js';

const databaseUrl = process.env.GANTRY_TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;
const schema = `gantry_deepagents_it_${process.pid}`;
const pool = databaseUrl
  ? new pg.Pool({ connectionString: databaseUrl })
  : null;

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

maybeDescribe('DeepAgentSessionStore Postgres checkpoint integration', () => {
  beforeAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    await ensureDeepAgentsCheckpointSchema({
      databaseUrl: databaseUrl ?? '',
      schema,
    });
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    await pool?.end();
  });

  it('persists and resumes checkpoint state through the official PostgresSaver', async () => {
    const timing = createDeepAgentCheckpointTiming({ nowMs: () => Date.now() });
    const store = new DeepAgentSessionStore(
      {
        databaseUrl: databaseUrl ?? '',
        schema,
      },
      timing,
    );
    const sessionId = store.newSessionId();
    const saver = await store.create(sessionId);
    await saver.put(
      { configurable: { thread_id: sessionId } },
      {
        v: 4,
        ts: new Date(0).toISOString(),
        id: 'checkpoint-1',
        channel_values: {
          messages: [{ role: 'human', content: 'hello from postgres' }],
        },
        channel_versions: { messages: 1 },
        versions_seen: {},
        pending_sends: [],
      },
      {},
      { messages: 1 },
    );
    await saver.end();

    const loaded = await store.load(sessionId);
    const tuple = await loaded.getTuple({
      configurable: { thread_id: sessionId },
    });
    await loaded.end();

    expect(tuple?.checkpoint.channel_values.messages).toEqual([
      { role: 'human', content: 'hello from postgres' },
    ]);
    expect(timing.snapshot()).toEqual(
      expect.objectContaining({
        loadCount: 2,
        loadMs: expect.any(Number),
        writeCount: 1,
        writeMs: expect.any(Number),
      }),
    );
  });

  it('fails resumed sessions before model startup when the checkpoint is missing', async () => {
    const store = new DeepAgentSessionStore({
      databaseUrl: databaseUrl ?? '',
      schema,
    });

    await expect(store.load('missing-session')).rejects.toThrow(
      MISSING_DEEPAGENTS_SESSION_MARKER,
    );
  });
});
