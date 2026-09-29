import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('live admission consumption backfill', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'input_backfill',
    });
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('keeps items after the saved queue marker waiting, including deferred and claimed items', async () => {
    const queue = 'tg:backfill::agent:main';
    const marker = JSON.stringify({
      timestamp: '2026-09-29T08:00:00.000Z',
      id: 'middle',
    });
    await runtime.service.pool.query(
      "INSERT INTO router_state(key, value) VALUES ('last_agent_timestamp', $1)",
      [JSON.stringify({ [queue]: marker })],
    );
    const entries = [
      ['before', '2026-09-29T07:59:00.000Z', 'queued'],
      ['middle', '2026-09-29T08:00:00.000Z', 'completed'],
      ['after', '2026-09-29T08:01:00.000Z', 'deferred'],
      ['claimed', '2026-09-29T08:02:00.000Z', 'claimed'],
    ] as const;
    for (const [id, timestamp, state] of entries) {
      await runtime.service.pool.query(
        `INSERT INTO live_admission_work_items
          (id, app_id, agent_id, conversation_id, queue_jid, message_id,
           message_cursor, idempotency_key, state, updated_at)
         VALUES ($1, 'app', 'main', 'tg:backfill', $2, $3, $4, $5, $6, now())`,
        [
          id,
          queue,
          `message:${id}`,
          JSON.stringify({ timestamp, id }),
          `admission:${id}`,
          state,
        ],
      );
    }
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/20260929081005_backfill_live_admission_consumption.sql',
      ),
      'utf8',
    );
    await runtime.service.pool.query(migration);
    const result = await runtime.service.pool.query<{
      id: string;
      consumed_by: string | null;
    }>('SELECT id, consumed_by FROM live_admission_work_items ORDER BY id');
    expect(
      Object.fromEntries(
        result.rows.map(({ id, consumed_by }) => [id, consumed_by]),
      ),
    ).toEqual({
      after: null,
      before: 'history',
      claimed: null,
      middle: 'history',
    });
  });
});
