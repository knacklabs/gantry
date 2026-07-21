// Matrix §2 + §3 (real model, behavioral): onboard via API, select `haiku`,
// run one real agent turn through the production gantry gateway, assert
// BEHAVIOR (completion + durable records), never reply phrasing.
//
// Credential seeding path (documented per the goal prompt):
//   PUT /v1/credentials/models/anthropic  { authMode: 'api_key', payload: { apiKey } }
//   -> apps/core/src/control/server/routes/credentials.ts (handleCredentialRoutes)
//   -> ModelCredentialService.set (application/model-credentials/model-credential-service.ts)
// The key is encrypted at rest with the run's generated SECRET_ENCRYPTION_KEY
// and projected to the runner by the gantry credential broker (default host
// credential mode 'gantry', src/config/credentials/mode.ts). No env fallback is
// used: the harness builds the runtime env from scratch, so the ONLY way the
// model credential reaches the isolated runtime is this Control API surface.
//
// Model selection surface: PATCH /v1/models/defaults { chat: 'haiku' }
// (routes/models.ts; preflight requires the seeded credential), confirmed via
// GET /v1/models/defaults (chat.effectiveAlias + provider.id).
//
// Gating: requires E2E_ANTHROPIC_API_KEY (protected CI secret — absent on fork
// PRs, so the suite self-skips) AND GANTRY_TEST_DATABASE_URL (throwaway admin
// Postgres, same as the hermetic lane).

import fs from 'node:fs';
import { globSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AgentE2EApiClient, type SessionEvent } from '../harness/api-client.js';
import {
  redactText,
  startEvidenceRun,
  type EvidenceRun,
} from '../harness/evidence.js';
import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const apiKey = process.env.E2E_ANTHROPIC_API_KEY?.trim();
const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
if (!apiKey) {
  // stderr directly: vitest swallows module-level console output.
  process.stderr.write('haiku-turn skipped: E2E_ANTHROPIC_API_KEY not set\n');
}
const maybeDescribe = apiKey && hasDb ? describe : describe.skip;

const BOOT_TIMEOUT_MS = 300_000;
// Generous: one real haiku turn including worker spawn + model latency.
const TURN_TIMEOUT_MS = 180_000;

interface ModelDefaultsResponse {
  provider: { id: string; label: string } | null;
  chat: {
    configuredAlias: string | null;
    effectiveAlias: string | null;
    model: { id: string } | null;
  };
}

function payloadOf(event: SessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
}

maybeDescribe('agent-e2e haiku turn (real model, behavioral)', () => {
  let harness: RuntimeHarness | undefined;
  let api: AgentE2EApiClient;
  let evidence: EvidenceRun | undefined;
  let sessionId = '';
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
        const secrets = harness.secrets.concat(apiKey ? [apiKey] : []);
        const tail = redactText(harness.logs().slice(-24000), secrets);
        evidence.evidence.redactedFailure = tail.slice(-4000);
        // CI keeps only test output, not the disposable home — surface the
        // runtime log tail where the failed job log can show it.
        console.error(`[haiku-turn] runtime log tail on failure:\n${tail}`);
        for (const agentLog of globSync(
          path.join(harness.home, 'agents', '*', 'logs', '*.log'),
        )) {
          const body = fs.readFileSync(agentLog, 'utf8');
          console.error(
            `[haiku-turn] ${path.basename(agentLog)} tail:\n` +
              redactText(body.slice(-8000), secrets),
          );
        }
      }
      evidence.write(
        process.env.AGENT_E2E_EVIDENCE_DIR ??
          path.join(os.tmpdir(), 'gantry-agent-e2e-evidence'),
      );
    }
    await harness?.teardown({ failed: sawFailure });
    // Teardown can exceed the 10s default when the runtime is mid-turn
    // (graceful stop -> SIGKILL fallback).
  }, 60_000);

  it(
    'boots, seeds the anthropic credential via API, selects haiku',
    { timeout: BOOT_TIMEOUT_MS },
    async () =>
      step(async () => {
        harness = await startRuntimeHarness({
          scopes: [
            'sessions:read',
            'sessions:write',
            'agents:admin',
            'credentials:admin',
          ],
        });
        api = new AgentE2EApiClient(harness.baseUrl, harness.apiKey);
        evidence = startEvidenceRun({
          scenario: 'haiku-turn',
          // The API key never enters the runtime env, but it appears in our
          // request bodies — scrub it from anything evidence writes.
          secrets: [...harness.secrets, apiKey as string],
        });

        evidence.phase('seed-credential');
        // The secret may be either a plain API key (sk-ant-api...) or a
        // Claude Code OAuth token; each maps to a different credential mode
        // (x-api-key vs Authorization: Bearer at the gateway). Seeding an
        // OAuth token as api_key yields an upstream 401 retry-loop zombie.
        const isOauthToken = !(apiKey as string).startsWith('sk-ant-api');
        if (!isOauthToken) {
          // Fail fast on a bad fixture key: Claude Code retries 401s ~10
          // times with minutes of backoff, so an invalid secret otherwise
          // presents as a 150s no-terminal-event zombie.
          const keyProbe = await fetch(
            'https://api.anthropic.com/v1/messages/count_tokens',
            {
              method: 'POST',
              headers: {
                'x-api-key': apiKey as string,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                messages: [{ role: 'user', content: 'ping' }],
              }),
            },
          );
          if (keyProbe.status === 401 || keyProbe.status === 403) {
            throw new Error(
              `E2E_ANTHROPIC_API_KEY was rejected by the Anthropic API ` +
                `(HTTP ${keyProbe.status}). Replace the repository secret ` +
                `with a valid Anthropic API key (sk-ant-api...).`,
            );
          }
        }
        const seeded = await api.request<{ status: string }>(
          'PUT',
          '/v1/credentials/models/anthropic',
          {
            body: isOauthToken
              ? {
                  authMode: 'claude_code_oauth',
                  payload: { oauthToken: apiKey },
                }
              : { authMode: 'api_key', payload: { apiKey } },
          },
        );
        expect(seeded.status).toBe(200);
        expect(seeded.body.status).toBe('active');

        evidence.phase('select-model');
        const patched = await api.request('PATCH', '/v1/models/defaults', {
          body: { chat: 'haiku' },
        });
        expect(patched.status).toBe(200);
        const defaults = await api.request<ModelDefaultsResponse>(
          'GET',
          '/v1/models/defaults',
        );
        expect(defaults.status).toBe(200);
        expect(defaults.body.chat.effectiveAlias).toBe('haiku');
        expect(defaults.body.provider?.id).toBe('anthropic');
        evidence.evidence.modelAlias = defaults.body.chat.effectiveAlias ?? '';
        evidence.evidence.provider = defaults.body.provider?.id ?? '';
        evidence.evidence.modelRoute = defaults.body.chat.model?.id ?? '';
      }),
  );

  it(
    'completes one real turn with durable run + delivery records',
    { timeout: TURN_TIMEOUT_MS },
    async () =>
      step(async () => {
        if (!harness || !evidence) throw new Error('boot test did not run');

        evidence.phase('onboard');
        const created = await api.request<{ id: string }>(
          'POST',
          '/v1/agents',
          { body: { appId: 'default', name: 'agent-e2e-haiku-turn' } },
        );
        expect(created.status).toBe(201);
        const agentId = created.body.id;
        expect(agentId).toMatch(/^agent:/);

        const ensured = await api.request<{ sessionId: string }>(
          'POST',
          '/v1/sessions/ensure',
          {
            body: {
              conversationId: 'haiku-turn-e2e',
              agentId,
              title: 'haiku turn e2e',
            },
          },
        );
        expect(ensured.status).toBe(200);
        sessionId = ensured.body.sessionId;
        expect(sessionId).toBeTruthy();
        evidence.evidence.sessionId = sessionId;

        evidence.phase('turn');
        const accepted = await api.postMessage(
          sessionId,
          'Reply with a single short sentence confirming you are operational.',
        );
        expect(accepted.accepted).toBe(true);

        const { terminal, events } = await api.waitForTerminalRunEvent(
          sessionId,
          { timeoutMs: TURN_TIMEOUT_MS - 30_000 },
        );
        evidence.events.push(...events);

        evidence.phase('verify');
        // Behavioral: the run completed (not failed/timeout/dead-lettered).
        expect(
          terminal.eventType,
          `terminal run event (payload: ${JSON.stringify(terminal.payload).slice(0, 300)})`,
        ).toBe('run.completed');

        // The run exists and executed on the anthropic claude-agent-sdk lane.
        const started = events.find((e) => e.eventType === 'run.started');
        expect(started, 'run.started event').toBeDefined();
        const startedPayload = payloadOf(started as SessionEvent);
        expect(startedPayload.execution_provider_id).toBe(
          'anthropic:claude-agent-sdk',
        );
        const runId = payloadOf(terminal).runId ?? startedPayload.runId;
        if (typeof runId === 'string') evidence.evidence.runId = runId;
        if (typeof startedPayload.agent_engine === 'string') {
          evidence.evidence.harness = startedPayload.agent_engine;
        }

        // A durable assistant delivery record exists: for API sessions the
        // outbound event IS the persisted delivery record (channels/app.ts).
        // NO assertion on reply phrasing — only that a non-empty reply exists.
        const outbound = events.find(
          (e) =>
            e.eventType === 'session.message.outbound' &&
            typeof payloadOf(e).text === 'string' &&
            (payloadOf(e).text as string).trim().length > 0,
        );
        expect(outbound, 'durable outbound assistant message').toBeDefined();

        // Usage evidence when surfaced: alias/provider consistent with haiku
        // on anthropic (covers alias or full runner model id).
        const usage = events.find((e) => e.eventType === 'model.usage');
        if (usage) {
          const usagePayload = payloadOf(usage);
          expect(String(usagePayload.modelAlias ?? '').toLowerCase()).toContain(
            'haiku',
          );
        }
        evidence.finishPhases();
      }),
  );
});
