// Matrix §6 (real model, behavioral): a packaged SDK worker asks to run one
// exact Bash command. The signed permission IPC request crosses the real host
// coordinator, where the run's fixed authority image must deny before the
// agent's reviewed allow rule. Assertions use durable Postgres evidence rather
// than reply wording.

import fs from 'node:fs';
import { globSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { requireRealModelCredential } from '../fixtures/model-credential-fixture.js';
import { AgentE2EApiClient } from '../harness/api-client.js';
import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const modelCredential = requireRealModelCredential();
const apiKey =
  'credential' in modelCredential ? modelCredential.credential : undefined;
const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
if ('skipReason' in modelCredential) {
  process.stderr.write(
    `coordinator-authority skipped: ${modelCredential.skipReason}\n`,
  );
}
if (!hasDb) {
  process.stderr.write(
    'coordinator-authority skipped: GANTRY_TEST_DATABASE_URL not set\n',
  );
}
const maybeDescribe = apiKey && hasDb ? describe : describe.skip;
const TEST_TIMEOUT_MS = 300_000;
const COMMAND = 'printf agent-e2e-coordinator-authority';
const REVIEWED_RULE = `RunCommand(${COMMAND})`;

interface AgentAccessResponse {
  selections: Array<{ id: string; version: string }>;
}

function installRuntimeSettings(home: string): void {
  fs.writeFileSync(
    path.join(home, 'settings.yaml'),
    `runtime:
  deployment_mode: workstation
  sandbox:
    provider: direct

storage:
  postgres:
    url_env: GANTRY_DATABASE_URL
    schema: gantry
`,
  );
}

maybeDescribe(
  'agent-e2e coordinator authority (packaged SDK runner, real model)',
  () => {
    let harness: RuntimeHarness | undefined;
    let fakeHome = '';
    let failed = false;

    afterAll(async () => {
      if (failed && harness) {
        const redactedRuntimeLog = harness
          .logs()
          .replaceAll(apiKey as string, '[REDACTED]');
        console.error(
          `[coordinator-authority] runtime log tail on failure:\n${redactedRuntimeLog.slice(-12000)}`,
        );
        for (const agentLog of globSync(
          path.join(fakeHome, 'agents', '*', 'logs', '*.log'),
        )) {
          const redactedAgentLog = fs
            .readFileSync(agentLog, 'utf8')
            .replaceAll(apiKey as string, '[REDACTED]');
          console.error(
            `[coordinator-authority] ${path.basename(agentLog)} tail:\n` +
              redactedAgentLog.slice(-12000),
          );
        }
      }
      try {
        await harness?.teardown({ failed });
      } finally {
        if (
          fakeHome &&
          !(failed && process.env.KEEP_EVIDENCE?.trim() === '1')
        ) {
          fs.rmSync(fakeHome, { recursive: true, force: true });
        }
      }
    }, 60_000);

    it(
      'denies one reviewed SDK tool decision at the fixed-image coordinator authority',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        try {
          fakeHome = fs.mkdtempSync(
            path.join(os.tmpdir(), 'gantry-agent-e2e-coordinator-home-'),
          );
          installRuntimeSettings(fakeHome);
          harness = await startRuntimeHarness({
            mode: 'local-process',
            scopes: [
              'sessions:read',
              'sessions:write',
              'agents:admin',
              'credentials:admin',
            ],
            env: {
              GANTRY_HOME: fakeHome,
              HOME: fakeHome,
              GANTRY_NO_PERMISSION_TOOLS: '1',
            },
          });
          const api = new AgentE2EApiClient(harness.baseUrl, harness.apiKey);

          const isOauthToken = !(apiKey as string).startsWith('sk-ant-api');
          const credential = await api.request<{ status: string }>(
            'PUT',
            '/v1/credentials/models/anthropic',
            {
              body: isOauthToken
                ? {
                    authMode: 'claude_code_oauth',
                    payload: { oauthToken: apiKey },
                  }
                : {
                    authMode: 'api_key',
                    payload: { apiKey },
                  },
            },
          );
          expect(credential.status).toBe(200);
          expect(credential.body.status).toBe('active');

          const selectedModel = await api.request(
            'PATCH',
            '/v1/models/defaults',
            { body: { chat: 'haiku' } },
          );
          expect(selectedModel.status).toBe(200);

          const created = await api.request<{ id: string }>(
            'POST',
            '/v1/agents',
            {
              body: {
                appId: 'default',
                name: 'agent-e2e-coordinator-authority',
              },
            },
          );
          expect(created.status).toBe(201);
          const agentId = created.body.id;

          const access = await api.request<AgentAccessResponse>(
            'PUT',
            `/v1/agents/${encodeURIComponent(agentId)}/access`,
            {
              body: {
                sources: { skills: [], mcpServers: [], tools: [] },
                selections: [{ id: REVIEWED_RULE, version: 'builtin' }],
              },
            },
          );
          expect(access.status).toBe(200);
          expect(access.body.selections).toContainEqual({
            id: REVIEWED_RULE,
            version: 'builtin',
          });

          const ensured = await api.request<{ sessionId: string }>(
            'POST',
            '/v1/sessions/ensure',
            {
              body: {
                conversationId: 'coordinator-authority-e2e',
                agentId,
                title: 'coordinator authority e2e',
              },
            },
          );
          expect(ensured.status).toBe(200);
          const accepted = await api.postMessage(
            ensured.body.sessionId,
            `Call Bash exactly once with this exact command, unchanged: ${COMMAND}. Do not call any other tool. After the permission result, reply with one short sentence.`,
          );
          expect(accepted.accepted).toBe(true);
          await api.waitForDurableAssistantReply(ensured.body.sessionId, {
            timeoutMs: TEST_TIMEOUT_MS - 60_000,
          });

          const client = new Client({ connectionString: harness.databaseUrl });
          await client.connect();
          try {
            const interactions = await client.query<{
              request_id: string;
              status: string;
              approver_ref: string | null;
              payload_json: {
                request?: {
                  toolName?: string;
                  toolInputSanitized?: Record<string, unknown>;
                };
              };
              resolution_json: Record<string, unknown>;
            }>(
              `SELECT request_id, status, approver_ref, payload_json, resolution_json
                 FROM gantry.pending_interactions
                WHERE kind = 'permission'`,
            );
            expect(interactions.rows).toEqual([
              expect.objectContaining({
                request_id: expect.any(String),
                status: 'resolved',
                approver_ref: 'fixed_image',
                payload_json: expect.objectContaining({
                  request: expect.objectContaining({
                    toolName: 'RunCommand',
                    toolInputSanitized: expect.objectContaining({
                      command: COMMAND,
                    }),
                  }),
                }),
                resolution_json: expect.objectContaining({
                  approved: false,
                  mode: 'cancel',
                }),
              }),
            ]);
            const requestId = interactions.rows[0]!.request_id;

            const decisions = await client.query<{
              effect: string;
              reason: string;
              approver_ref: string | null;
            }>(
              `SELECT effect, reason, approver_ref
                 FROM gantry.permission_decisions
                WHERE actor_context_json::jsonb ->> 'requestId' = $1`,
              [requestId],
            );
            expect(decisions.rows).toEqual([
              {
                effect: 'deny',
                reason:
                  'capability not provisioned: this run uses a fixed authority image.',
                approver_ref: 'fixed_image',
              },
            ]);

            const events = await client.query<{ event_type: string }>(
              `SELECT event_type
                 FROM gantry.runtime_events
                WHERE correlation_id = $1
                  AND event_type LIKE 'permission.%'
                ORDER BY event_id`,
              [requestId],
            );
            expect(events.rows.map((event) => event.event_type)).toEqual([
              'permission.requested',
              'permission.cancelled',
              'permission.final_outcome',
            ]);
          } finally {
            await client.end();
          }
        } catch (error) {
          failed = true;
          throw error;
        }
      },
    );
  },
);
