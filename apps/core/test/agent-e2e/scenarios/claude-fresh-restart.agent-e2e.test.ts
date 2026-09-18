import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { AgentE2EApiClient } from '../harness/api-client.js';
import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL?.trim()
  ? describe
  : describe.skip;
const TIMEOUT_MS = 300_000;

maybeDescribe('Claude fresh restart', () => {
  let harness: RuntimeHarness | undefined;

  afterAll(async () => {
    await harness?.teardown();
  });

  it(
    'restarts Claude without duplicate provider history',
    { timeout: TIMEOUT_MS },
    async () => {
      harness = await startRuntimeHarness({
        scopes: ['sessions:read', 'sessions:write'],
      });
      const api = new AgentE2EApiClient(harness.baseUrl, harness.apiKey);
      const session = await api.ensureSession({
        conversationId: 'claude-fresh-restart',
      });
      const client = new Client({ connectionString: harness.databaseUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO provider_sessions
             (id, app_id, agent_session_id, provider, external_session_id,
              provider_ref_json, metadata_json, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, 'active')`,
          [
            'provider-session:stale-claude',
            'default',
            session.sessionId,
            'anthropic:claude-agent-sdk',
            'claude-sdk-handle',
            JSON.stringify({
              kind: 'provider_session',
              value: 'anthropic:claude-agent-sdk:claude-sdk-handle',
            }),
          ],
        );

        const before = await api.request<{ providerSession: unknown }>(
          'GET',
          `/v1/sessions/${encodeURIComponent(session.sessionId)}`,
        );
        expect(before.status).toBe(200);
        expect(before.body.providerSession).toBeNull();

        await harness.restart();

        const after = await api.request<{ providerSession: unknown }>(
          'GET',
          `/v1/sessions/${encodeURIComponent(session.sessionId)}`,
        );
        expect(after.status).toBe(200);
        expect(after.body.providerSession).toBeNull();
        const rows = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM provider_sessions
            WHERE agent_session_id = $1
              AND provider = 'anthropic:claude-agent-sdk'`,
          [session.sessionId],
        );
        expect(rows.rows[0]?.count).toBe(1);
      } finally {
        await client.end();
      }
    },
  );
});
