import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import { IDLE_CANDIDATES_SQL } from '@core/runtime/idle-session-sweep.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe(
  'idle sweep uses memory_extraction_cursor for eligibility',
  () => {
    let runtime: PostgresIntegrationRuntime;

    // IDs shared across fixtures
    const APP_ID = 'app:sweep-cursor-test';
    const AGENT_ID = 'agent:boondi_support';
    const PROVIDER_ID = 'interakt';
    const PROVIDER_CONN_ID = 'conn:sweep-cursor-test';

    // Conversation / session IDs for each scenario
    const CONV_A = 'conversation:sweep:covered';
    const CONV_B = 'conversation:sweep:new-input';
    const CONV_C = 'conversation:sweep:never-extracted';

    const SESSION_A = 'session:sweep:covered';
    const SESSION_B = 'session:sweep:new-input';
    const SESSION_C = 'session:sweep:never-extracted';

    // Times — pick values that are clearly before/after each other
    const T1 = '2025-01-01T10:00:00.000Z'; // oldest message
    const T2 = '2025-01-01T11:00:00.000Z'; // cursor covered_through_at (A and B)
    const T3 = '2025-01-01T12:00:00.000Z'; // newer inbound for B (after cursor)

    // For scenario A: last_inbound_at == T1, cursor covers through T2 (>= T1 → covered)
    // For scenario B: inbound at T1 AND T3, cursor covers through T2 (< T3 → new input)
    // For scenario C: no cursor row → always eligible

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'idle_sweep_cursor',
      });

      const pool = runtime.service.pool;

      // ── Seed shared prerequisites ────────────────────────────────────────────
      await pool.query(
        `INSERT INTO apps (id, slug, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
        [APP_ID, 'sweep-cursor-test', 'Sweep Cursor Test'],
      );

      await pool.query(
        `INSERT INTO providers (id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
        [PROVIDER_ID, 'Interakt'],
      );

      await pool.query(
        `INSERT INTO provider_connections (id, app_id, provider_id, label, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'test-conn', 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
        [PROVIDER_CONN_ID, APP_ID, PROVIDER_ID],
      );

      await pool.query(
        `INSERT INTO agents (id, app_id, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
        [AGENT_ID, APP_ID, 'Boondi Support'],
      );

      // ── Conversations ─────────────────────────────────────────────────────────
      for (const convId of [CONV_A, CONV_B, CONV_C]) {
        await pool.query(
          `INSERT INTO conversations (id, app_id, provider_connection_id, kind, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'dm', 'active', now(), now())
         ON CONFLICT (id) DO NOTHING`,
          [convId, APP_ID, PROVIDER_CONN_ID],
        );
      }

      // ── Sessions (status='active', thread_id=null) ─────────────────────────
      for (const [sessionId, convId] of [
        [SESSION_A, CONV_A],
        [SESSION_B, CONV_B],
        [SESSION_C, CONV_C],
      ]) {
        await pool.query(
          `INSERT INTO agent_sessions (id, app_id, agent_id, conversation_id, thread_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, 'active', now(), now())
         ON CONFLICT (id) DO NOTHING`,
          [sessionId, APP_ID, AGENT_ID, convId],
        );
      }

      // ── Messages ──────────────────────────────────────────────────────────────
      // Scenario A: one inbound at T1 (covered by cursor at T2)
      await pool.query(
        `INSERT INTO messages (id, app_id, provider, provider_connection_id, conversation_id, thread_id, direction, trust, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'inbound', 'full', $6::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
        ['msg:A:1', APP_ID, PROVIDER_ID, PROVIDER_CONN_ID, CONV_A, T1],
      );

      // Scenario B: inbound at T1 (covered) + inbound at T3 (after cursor)
      await pool.query(
        `INSERT INTO messages (id, app_id, provider, provider_connection_id, conversation_id, thread_id, direction, trust, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'inbound', 'full', $6::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
        ['msg:B:1', APP_ID, PROVIDER_ID, PROVIDER_CONN_ID, CONV_B, T1],
      );
      await pool.query(
        `INSERT INTO messages (id, app_id, provider, provider_connection_id, conversation_id, thread_id, direction, trust, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'inbound', 'full', $6::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
        ['msg:B:2', APP_ID, PROVIDER_ID, PROVIDER_CONN_ID, CONV_B, T3],
      );

      // Scenario C: one inbound at T1 (no cursor → eligible)
      await pool.query(
        `INSERT INTO messages (id, app_id, provider, provider_connection_id, conversation_id, thread_id, direction, trust, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'inbound', 'full', $6::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
        ['msg:C:1', APP_ID, PROVIDER_ID, PROVIDER_CONN_ID, CONV_C, T1],
      );

      // ── Cursors (A and B only; C gets none) ──────────────────────────────────
      const cursorRepo = runtime.repositories.memoryExtractionCursor;

      // A: covered_through_at = T2 >= T1 (last inbound) → NOT eligible
      await cursorRepo.upsertCursor({
        appId: APP_ID as never,
        agentId: AGENT_ID as never,
        conversationId: CONV_A as never,
        threadId: null,
        coveredThroughAt: T2,
        coveredThroughMessageId: 'msg:A:1',
      });

      // B: covered_through_at = T2 < T3 (last inbound) → eligible
      await cursorRepo.upsertCursor({
        appId: APP_ID as never,
        agentId: AGENT_ID as never,
        conversationId: CONV_B as never,
        threadId: null,
        coveredThroughAt: T2,
        coveredThroughMessageId: 'msg:B:1',
      });

      // C: no cursor row → eligible
    }, 60_000);

    afterAll(async () => {
      await runtime.cleanup();
    });

    it('selects only the sessions with unextracted inbound messages (B and C), and excludes the covered session (A)', async () => {
      // Pass a far-future cutoff so every session appears idle
      const FAR_FUTURE = '2999-01-01T00:00:00.000Z';
      const result = await runtime.service.pool.query<{
        agent_session_id: string;
      }>(IDLE_CANDIDATES_SQL, [[AGENT_ID], FAR_FUTURE, 50]);

      const ids = result.rows.map((r) => r.agent_session_id);

      // B and C must be selected
      expect(ids).toContain(SESSION_B);
      expect(ids).toContain(SESSION_C);

      // A must NOT be selected (cursor covers all its inbound messages)
      expect(ids).not.toContain(SESSION_A);
    });
  },
);
