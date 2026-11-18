// Matrix §13 (real model, behavioral): seed an OpenAI credential through the
// Control API, select `gpt-luna`, then run one real turn through the packaged
// Gantry runtime. This specifically guards GPT-5.6 routing through OpenAI's
// Responses API while function tools are bound by DeepAgents.
//
// Gating: requires E2E_OPENAI_MODEL_API_KEY (protected CI/local secret) and
// GANTRY_TEST_DATABASE_URL (throwaway admin Postgres). The suite self-skips
// when either is absent; the credential is encrypted in the disposable home.

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

const apiKey = process.env.E2E_OPENAI_MODEL_API_KEY?.trim();
const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
if (!apiKey) {
  process.stderr.write(
    'gpt56-openai-turn skipped: E2E_OPENAI_MODEL_API_KEY not set\n',
  );
}
const maybeDescribe = apiKey && hasDb ? describe : describe.skip;

const BOOT_TIMEOUT_MS = 300_000;
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

maybeDescribe('agent-e2e GPT-5.6 OpenAI turn (real model)', () => {
  let harness: RuntimeHarness | undefined;
  let api: AgentE2EApiClient;
  let evidence: EvidenceRun | undefined;
  let sawFailure = false;

  async function step<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      sawFailure = true;
      throw error;
    }
  }

  afterAll(async () => {
    if (evidence && harness) {
      if (sawFailure) {
        const secrets = harness.secrets.concat(apiKey ? [apiKey] : []);
        const tail = redactText(harness.logs().slice(-24_000), secrets);
        evidence.evidence.redactedFailure = tail.slice(-4_000);
        console.error(`[gpt56-openai-turn] runtime log tail:\n${tail}`);
        for (const agentLog of globSync(
          path.join(harness.home, 'agents', '*', 'logs', '*.log'),
        )) {
          const body = fs.readFileSync(agentLog, 'utf8');
          console.error(
            `[gpt56-openai-turn] ${path.basename(agentLog)} tail:\n` +
              redactText(body.slice(-8_000), secrets),
          );
        }
      }
      evidence.write(
        process.env.AGENT_E2E_EVIDENCE_DIR ??
          path.join(os.tmpdir(), 'gantry-agent-e2e-evidence'),
      );
    }
    await harness?.teardown({ failed: sawFailure });
  }, 60_000);

  it(
    'boots, seeds the OpenAI credential, and selects gpt-luna',
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
          scenario: 'gpt56-openai-turn',
          secrets: [...harness.secrets, apiKey as string],
        });

        evidence.phase('seed-credential');
        const seeded = await api.request<{ status: string }>(
          'PUT',
          '/v1/credentials/models/openai',
          {
            body: { authMode: 'api_key', payload: { apiKey } },
          },
        );
        expect(seeded.status).toBe(200);
        expect(seeded.body.status).toBe('active');

        evidence.phase('select-model');
        const patched = await api.request('PATCH', '/v1/models/defaults', {
          body: { chat: 'gpt-luna' },
        });
        expect(patched.status).toBe(200);
        const defaults = await api.request<ModelDefaultsResponse>(
          'GET',
          '/v1/models/defaults',
        );
        expect(defaults.status).toBe(200);
        expect(defaults.body.chat.effectiveAlias).toBe('gpt-luna');
        expect(defaults.body.provider?.id).toBe('openai');
        evidence.evidence.modelAlias = defaults.body.chat.effectiveAlias ?? '';
        evidence.evidence.provider = defaults.body.provider?.id ?? '';
        evidence.evidence.modelRoute = defaults.body.chat.model?.id ?? '';
      }),
  );

  it(
    'completes a Responses API turn with durable run and reply records',
    { timeout: TURN_TIMEOUT_MS },
    async () =>
      step(async () => {
        if (!harness || !evidence) throw new Error('boot test did not run');

        evidence.phase('onboard');
        const created = await api.request<{ id: string }>(
          'POST',
          '/v1/agents',
          { body: { appId: 'default', name: 'agent-e2e-gpt56-openai-turn' } },
        );
        expect(created.status).toBe(201);
        expect(created.body.id).toMatch(/^agent:/);

        const ensured = await api.request<{ sessionId: string }>(
          'POST',
          '/v1/sessions/ensure',
          {
            body: {
              conversationId: 'gpt56-openai-turn-e2e',
              agentId: created.body.id,
              title: 'GPT-5.6 OpenAI turn e2e',
            },
          },
        );
        expect(ensured.status).toBe(200);
        const sessionId = ensured.body.sessionId;
        expect(sessionId).toBeTruthy();
        evidence.evidence.sessionId = sessionId;

        evidence.phase('turn');
        const accepted = await api.postMessage(
          sessionId,
          'Reply with one short sentence confirming you are operational.',
        );
        expect(accepted.accepted).toBe(true);

        const { reply, events } = await api.waitForDurableAssistantReply(
          sessionId,
          { timeoutMs: TURN_TIMEOUT_MS - 30_000 },
        );
        evidence.events.push(...events);

        evidence.phase('verify');
        const persistedMessage = await api.waitForPersistedAssistantMessage(
          sessionId,
          { timeoutMs: 30_000 },
        );
        const runs = await api.listRuns(sessionId);
        expect(runs.length, 'session run is visible').toBeGreaterThan(0);
        expect(
          events.some((event) => event.eventType === 'run.started'),
          'run.started is visible in the session event feed',
        ).toBe(true);
        expect(reply, 'durable assistant reply').toBeDefined();
        expect(persistedMessage).toBeDefined();

        const usage = events.find((event) => event.eventType === 'model.usage');
        if (usage) {
          const usagePayload = payloadOf(usage);
          expect(String(usagePayload.modelAlias ?? '').toLowerCase()).toContain(
            'luna',
          );
        }
        evidence.finishPhases();
      }),
  );
});
