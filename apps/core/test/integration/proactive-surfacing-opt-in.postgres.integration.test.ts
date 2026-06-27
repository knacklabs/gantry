import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_APP_ID } from '@core/adapters/storage/postgres/seeds.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import { PostgresProactiveSurfacingRepository } from '@core/adapters/storage/postgres/repositories/proactive-surfacing-repository.postgres.js';
import type { AppId } from '@core/domain/app/app.js';

// Exercises the live SQL (migration + opt-in upsert) against a real Postgres.
// Skipped unless GANTRY_TEST_DATABASE_URL is set.
const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

const appId = DEFAULT_APP_ID as AppId;

maybeDescribe('proactive_surfacing_opt_ins Postgres', () => {
  let service: PostgresStorageService;
  let repo: PostgresProactiveSurfacingRepository;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `proactive_surfacing_test_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    await service.migrate();
    repo = new PostgresProactiveSurfacingRepository(service.db);
  });

  afterAll(async () => {
    if (service) {
      await service.pool.query(
        `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
      );
      await service.close();
    }
  });

  it('migration creates proactive_surfacing_opt_ins with audit columns', async () => {
    const result = await service.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'proactive_surfacing_opt_ins'`,
      [schemaName],
    );
    const columns = result.rows.map((row) => row.column_name as string);
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'app_id',
        'agent_id',
        'subject_type',
        'subject_id',
        'conversation_jid',
        'proactive_surfacing_enabled',
        'enabled_at',
        'opted_out_at',
        'enabled_by_actor_id',
        'opted_out_by_actor_id',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('getBySubject returns null when no opt-in, enables, then opts out', async () => {
    const subject = {
      appId,
      agentId: 'agent:test',
      subjectType: 'user',
      subjectId: 'user:abc',
    };
    const nowIso = new Date().toISOString();
    const now2 = new Date(Date.now() + 1000).toISOString();

    expect(await repo.getBySubject(subject)).toBeNull();

    const enabled = await repo.setEnabled({
      subject,
      id: 'pso_1',
      conversationJid: 'jid:room@x',
      actorId: 'folder:owner',
      nowIso,
    });
    expect(enabled.proactiveSurfacingEnabled).toBe(true);
    // Postgres normalizes the timestamptz string format, so compare instants.
    expect(new Date(enabled.enabledAt ?? '').getTime()).toBe(
      new Date(nowIso).getTime(),
    );
    expect(enabled.optedOutAt).toBeNull();
    expect(enabled.conversationJid).toBe('jid:room@x');
    expect(enabled.enabledByActorId).toBe('folder:owner');

    const fetched = await repo.getBySubject(subject);
    expect(fetched).toEqual(enabled);

    const optedOut = await repo.setOptedOut({
      subject,
      actorId: 'folder:owner',
      nowIso: now2,
    });
    expect(optedOut?.proactiveSurfacingEnabled).toBe(false);
    expect(new Date(optedOut?.optedOutAt ?? '').getTime()).toBe(
      new Date(now2).getTime(),
    );

    const afterOptOut = await repo.getBySubject(subject);
    expect(afterOptOut?.proactiveSurfacingEnabled).toBe(false);
    expect(new Date(afterOptOut?.optedOutAt ?? '').getTime()).toBe(
      new Date(now2).getTime(),
    );
  });

  it('setEnabled is idempotent on the subject tuple (upsert, no duplicate)', async () => {
    const subject = {
      appId,
      agentId: 'agent:test',
      subjectType: 'conversation',
      subjectId: 'conversation:abc',
    };
    const nowIso = new Date().toISOString();
    const now2 = new Date(Date.now() + 1000).toISOString();

    await repo.setEnabled({ subject, id: 'pso_2', nowIso });
    await repo.setEnabled({ subject, id: 'pso_3', nowIso: now2 });

    const fetched = await repo.getBySubject(subject);
    expect(fetched?.id).toBe('pso_2');
    expect(fetched?.proactiveSurfacingEnabled).toBe(true);

    const result = await service.pool.query(
      `SELECT count(*)::int AS count FROM proactive_surfacing_opt_ins
       WHERE app_id = $1 AND agent_id = $2 AND subject_type = $3 AND subject_id = $4`,
      [subject.appId, subject.agentId, subject.subjectType, subject.subjectId],
    );
    expect(result.rows[0]?.count).toBe(1);
  });
});
