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
// Gating: requires E2E_MODEL_API_KEY (protected CI secret — absent on fork
// PRs, so the suite self-skips) AND GANTRY_TEST_DATABASE_URL (throwaway admin
// Postgres, same as the hermetic lane).

import fs from 'node:fs';
import { globSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { requireRealModelCredential } from '../fixtures/model-credential-fixture.js';
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

const modelCredential = requireRealModelCredential();
const apiKey =
  'credential' in modelCredential ? modelCredential.credential : undefined;
const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
if ('skipReason' in modelCredential) {
  // stderr directly: vitest swallows module-level console output.
  process.stderr.write(`haiku-turn skipped: ${modelCredential.skipReason}\n`);
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
        // All real model traffic flows through the agent path (gateway ->
        // Claude Code); the test never calls the provider API directly. A bad
        // credential surfaces as error_status=401 in the failure log dump.
        const isOauthToken = !(apiKey as string).startsWith('sk-ant-api');
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

        // Live sessions deliberately keep the run OPEN after replying (the
        // persistent SDK session waits for follow-ups; run.completed lands
        // only after the live idle window) and STREAM the reply, so no
        // separate outbound event fires. The behavioral completion signal is
        // the durable outbound message ROW; a run failure before it is fatal.
        const { reply, events } = await api.waitForDurableAssistantReply(
          sessionId,
          { timeoutMs: TURN_TIMEOUT_MS - 30_000 },
        );
        evidence.events.push(...events);

        evidence.phase('verify');
        // Run-lane evidence (executionProviderId) is NOT asserted yet: the
        // session events feed filters run.* events and GET /sessions/{id}/runs
        // maps the control-session id into agent-session id space, so it has
        // always returned [] for app sessions — matrix row pins that API fix.
        // The streamed durable reply above IS the composed turn proof.

        // Durable persisted reply row exists. NO assertion on reply phrasing.
        expect(
          reply,
          'durable assistant reply (event-sourced app channel)',
        ).toBeDefined();

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
