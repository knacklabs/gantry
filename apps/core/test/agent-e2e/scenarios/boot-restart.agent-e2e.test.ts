// Matrix §1 rows 1-2 (hermetic — NO model credential):
// 1. The packaged runtime boots against a fresh home + disposable database,
//    health goes green, migrations are applied (asserted via /readyz AND the
//    drizzle migrations table in the per-run database).
// 2. restart() preserves desired state: an agent created via the Control API
//    (desired-state surface) before the restart is still projected after it.
// Teardown is clean: the per-run database is dropped and the home removed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { AgentE2EApiClient } from '../harness/api-client.js';
import { startEvidenceRun, type EvidenceRun } from '../harness/evidence.js';
import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
const maybeDescribe = hasDb ? describe : describe.skip;

const BOOT_TIMEOUT_MS = 300_000;
const AGENT_MARKER_NAME = 'agent-e2e-restart-marker';

interface AgentResponse {
  id: string;
  name: string;
  status: string;
}

maybeDescribe('agent-e2e boot + restart (packaged runtime, hermetic)', () => {
  let harness: RuntimeHarness | undefined;
  let api: AgentE2EApiClient;
  let evidence: EvidenceRun | undefined;
  let markerAgentId = '';
  let sawFailure = false;

  async function step<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      sawFailure = true;
      throw err;
    }
  }

  afterAll(async () => {
    if (evidence && harness) {
      if (sawFailure) {
        evidence.evidence.redactedFailure = harness.logs().slice(-4000);
      }
      evidence.write(
        process.env.AGENT_E2E_EVIDENCE_DIR ??
          path.join(os.tmpdir(), 'gantry-agent-e2e-evidence'),
      );
    }
    // Idempotent: the teardown-clean test already tore down on success.
    await harness?.teardown({ failed: sawFailure });
  });

  it(
    'boots healthy with migrations applied',
    { timeout: BOOT_TIMEOUT_MS },
    async () =>
      step(async () => {
        harness = await startRuntimeHarness({
          scopes: ['sessions:read', 'sessions:write', 'agents:admin'],
        });
        api = new AgentE2EApiClient(harness.baseUrl, harness.apiKey);
        evidence = startEvidenceRun({
          scenario: 'boot-restart',
          secrets: harness.secrets,
        });
        evidence.phase('verify-boot');

        // Health green (readiness already gated startRuntimeHarness; assert
        // the public contract explicitly).
        const health = await fetch(`${harness.baseUrl}/healthz`);
        expect(health.status).toBe(200);
        const ready = await fetch(`${harness.baseUrl}/readyz`);
        expect(ready.status).toBe(200);
        const readyBody = (await ready.json()) as {
          status: string;
          checks: Record<string, string>;
        };
        expect(readyBody.status).toBe('ready');
        expect(readyBody.checks.migrations).toBe('pass');
        expect(readyBody.checks.database).toBe('pass');

        // Migrations applied — asserted directly in the PER-RUN database.
        const client = new Client({ connectionString: harness.databaseUrl });
        await client.connect();
        try {
          const applied = await client.query(
            'SELECT count(*)::int AS applied FROM "gantry"."__drizzle_migrations"',
          );
          expect(applied.rows[0].applied).toBeGreaterThan(0);
        } finally {
          await client.end();
        }

        // Bearer auth is live: the run's generated key works, garbage fails.
        const authed = await api.request('GET', '/v1/agents');
        expect(authed.status).toBe(200);
        const unauthed = await fetch(`${harness.baseUrl}/v1/agents`);
        expect(unauthed.status).toBe(401);
      }),
  );

  it(
    'restart preserves a desired-state marker created via the API',
    { timeout: BOOT_TIMEOUT_MS },
    async () =>
      step(async () => {
        if (!harness || !evidence) throw new Error('boot test did not run');
        evidence.phase('create-marker');
        const created = await api.request<AgentResponse>('POST', '/v1/agents', {
          body: { appId: 'default', name: AGENT_MARKER_NAME },
        });
        expect(created.status).toBe(201);
        expect(created.body.name).toBe(AGENT_MARKER_NAME);
        markerAgentId = created.body.id;
        expect(markerAgentId).toMatch(/^agent:/);

        evidence.phase('restart');
        await harness.restart();

        evidence.phase('verify-post-restart');
        const listed = await api.request<{ agents: AgentResponse[] }>(
          'GET',
          '/v1/agents',
        );
        expect(listed.status).toBe(200);
        const marker = listed.body.agents.find(
          (agent) => agent.id === markerAgentId,
        );
        expect(marker, 'marker agent projected post-restart').toBeDefined();
        expect(marker?.name).toBe(AGENT_MARKER_NAME);
        expect(marker?.status).toBe('active');
      }),
  );

  it(
    'teardown drops the database and removes the home',
    { timeout: BOOT_TIMEOUT_MS },
    async () =>
      step(async () => {
        if (!harness) throw new Error('boot test did not run');
        const { home, databaseName } = harness;
        evidence?.phase('teardown');
        await harness.teardown();
        evidence?.finishPhases();

        expect(fs.existsSync(home)).toBe(false);
        const admin = new Client({
          connectionString: process.env.GANTRY_TEST_DATABASE_URL,
        });
        await admin.connect();
        try {
          const remaining = await admin.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [databaseName],
          );
          expect(remaining.rowCount).toBe(0);
        } finally {
          await admin.end();
        }
      }),
  );
});
