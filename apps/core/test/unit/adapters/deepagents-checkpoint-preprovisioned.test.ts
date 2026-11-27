import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ensureDeepAgentsCheckpointSchema } from '@core/adapters/llm/deepagents-langchain/checkpoint-setup.js';

const integration = process.env.GANTRY_DATABASE_URL ? describe : describe.skip;
integration('dedicated-role official checkpoint setup', () => {
  it('runs official migrations and reads checkpoints without database CREATE', async () => {
    const databaseUrl = process.env.GANTRY_DATABASE_URL!;
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const result = await pool.query(
        `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create, pg_get_userbyid(n.nspowner) = current_user AS owns FROM pg_namespace n WHERE n.nspname = 'gantry_deepagents'`,
      );
      expect(result.rows).toEqual([{ can_create: false, owns: true }]);
      await ensureDeepAgentsCheckpointSchema({
        databaseUrl,
        schema: 'gantry_deepagents',
        requirePreprovisionedSchema: true,
      });
      const saver = new PostgresSaver(pool, undefined, {
        schema: 'gantry_deepagents',
      });
      expect(
        await saver.getTuple({
          configurable: {
            thread_id: 'checkpoint-role-regression-no-checkpoint',
          },
        }),
      ).toBeUndefined();
      const migrations = await pool.query(
        'SELECT count(*)::int AS count FROM gantry_deepagents.checkpoint_migrations',
      );
      expect(migrations.rows[0].count).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
  it('fails clearly for a missing or differently owned namespace', async () => {
    for (const schema of ['checkpoint_missing_regression', 'public']) {
      await expect(
        ensureDeepAgentsCheckpointSchema({
          databaseUrl: process.env.GANTRY_DATABASE_URL!,
          schema,
          requirePreprovisionedSchema: true,
        }),
      ).rejects.toThrow(
        'preprovisioned and owned by the runtime database role',
      );
    }
  });
});
