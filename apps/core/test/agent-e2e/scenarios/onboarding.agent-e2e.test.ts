import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { AgentE2EApiClient } from '../harness/api-client.js';
import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
const maybeDescribe = hasDb ? describe : describe.skip;
const BOOT_TIMEOUT_MS = 300_000;
const AGENT_FOLDER = 'e2e_boot_onboarding';
const AGENT_ID = `agent:${AGENT_FOLDER}`;
const AGENT_NAME = 'E2E Boot Onboarding';
const PROVIDER_ACCOUNT_ID = 'control:default';
const CONVERSATION_KEY = `${AGENT_FOLDER}_conversation`;
const ADDED_AT = '2026-07-21T00:00:00.000Z';

interface DesiredStateResponse {
  revision: number;
  settings: Record<string, unknown> | null;
  updatedAt: string | null;
}

interface CapabilityResponse {
  id: string;
  version: string;
}

interface AgentResponse {
  id: string;
  name: string;
  status: string;
}

interface ConversationInstallResponse {
  id: string;
  agentId: string;
  providerAccountId: string;
  conversationId: string;
  status: string;
}

interface AgentAccessResponse {
  agentId: string;
  selections: CapabilityResponse[];
}

interface ModelPreviewResponse {
  target: string;
  scope: string;
}

function recordAt(
  document: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = document[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Desired-state document is missing object ${key}`);
  }
  return value as Record<string, unknown>;
}

async function durableProjection(
  databaseUrl: string,
  expectedRevision: number,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const revision = await client.query<{ revision: number }>(
      'SELECT max(revision)::int AS revision FROM "gantry"."settings_revisions" WHERE app_id = $1',
      ['default'],
    );
    expect(revision.rows[0]?.revision).toBe(expectedRevision);

    const projection = await client.query(
      `SELECT a.id AS agent_id,
              pa.id AS provider_account_id,
              c.id AS conversation_id,
              ci.id AS install_id,
              atb.id AS tool_binding_id
         FROM "gantry"."agents" a
         JOIN "gantry"."provider_accounts" pa
           ON pa.app_id = a.app_id AND pa.agent_id = a.id
         JOIN "gantry"."conversations" c
           ON c.app_id = a.app_id AND c.provider_account_id = pa.id
         JOIN "gantry"."conversation_installs" ci
           ON ci.app_id = a.app_id
          AND ci.agent_id = a.id
          AND ci.provider_account_id = pa.id
          AND ci.conversation_id = c.id
          AND ci.status = 'active'
         JOIN "gantry"."agent_tool_bindings" atb
           ON atb.app_id = a.app_id
          AND atb.agent_id = a.id
          AND atb.status = 'active'
        WHERE a.id = $1 AND a.status = 'active' AND pa.id = $2`,
      [AGENT_ID, PROVIDER_ACCOUNT_ID],
    );
    expect(projection.rowCount).toBeGreaterThan(0);
    expect(projection.rows[0]).toMatchObject({
      agent_id: AGENT_ID,
      provider_account_id: PROVIDER_ACCOUNT_ID,
    });
  } finally {
    await client.end();
  }
}

maybeDescribe('agent-e2e onboarding (public desired-state API)', () => {
  let harness: RuntimeHarness | undefined;
  let sawFailure = false;

  afterAll(async () => {
    await harness?.teardown({ failed: sawFailure });
  });

  it(
    'appends a revision and reconstitutes the agent, binding, and grant after restart',
    { timeout: BOOT_TIMEOUT_MS },
    async () => {
      try {
        harness = await startRuntimeHarness({
          scopes: [
            'sessions:read',
            'sessions:write',
            'agents:admin',
            'conversations:read',
            'conversations:admin',
          ],
        });
        const api = new AgentE2EApiClient(harness.baseUrl, harness.apiKey);

        const baseline = await api.request<DesiredStateResponse>(
          'GET',
          '/v1/settings/desired-state',
        );
        expect(baseline.status).toBe(200);
        expect(Number.isInteger(baseline.body.revision)).toBe(true);
        expect(baseline.body.settings).not.toBeNull();

        const catalog = await api.request<{
          capabilities: CapabilityResponse[];
        }>('GET', '/v1/capabilities');
        expect(catalog.status).toBe(200);
        expect(Array.isArray(catalog.body.capabilities)).toBe(true);
        const catalogCapability = catalog.body.capabilities.find(
          (entry) => entry.id.length > 0 && entry.version.length > 0,
        );
        expect(
          catalogCapability,
          'a persistent built-in capability',
        ).toBeDefined();
        if (!catalogCapability) throw new Error('Capability catalog is empty');
        const capability = {
          id: catalogCapability.id,
          version: catalogCapability.version,
        };

        const settings = structuredClone(
          baseline.body.settings as Record<string, unknown>,
        );
        recordAt(settings, 'providers').app = { enabled: true };
        recordAt(settings, 'provider_accounts')[PROVIDER_ACCOUNT_ID] = {
          agent: AGENT_FOLDER,
          provider: 'app',
          label: AGENT_NAME,
          runtime_secret_refs: {},
        };
        recordAt(settings, 'agents')[AGENT_FOLDER] = {
          name: AGENT_NAME,
          access: {
            preset: 'full',
            sources: { skills: [], mcp_servers: [], tools: [] },
            selections: [capability],
          },
        };
        recordAt(settings, 'conversations')[CONVERSATION_KEY] = {
          provider_account: PROVIDER_ACCOUNT_ID,
          external_id: `default:${AGENT_FOLDER}`,
          kind: 'group',
          display_name: AGENT_NAME,
          sender_policy: { allow: '*', mode: 'trigger' },
          control_approvers: [],
          installed_agents: {
            [AGENT_FOLDER]: {
              provider_account: PROVIDER_ACCOUNT_ID,
              status: 'active',
              added_at: ADDED_AT,
              memory_scope: 'conversation',
              requires_trigger: false,
            },
          },
        };

        const written = await api.request<{ revision: number }>(
          'PUT',
          '/v1/settings/desired-state',
          {
            body: {
              settings,
              expectedRevision: baseline.body.revision,
              note: 'agent-e2e onboarding',
            },
          },
        );
        expect(written.status, JSON.stringify(written.body)).toBe(200);
        expect(written.body.revision).toBeGreaterThan(baseline.body.revision);

        const createdAgent = await api.request<AgentResponse>(
          'GET',
          `/v1/agents/${encodeURIComponent(AGENT_ID)}`,
        );
        expect(createdAgent.status).toBe(200);
        expect(createdAgent.body).toMatchObject({
          id: AGENT_ID,
          name: AGENT_NAME,
          status: 'active',
        });

        await durableProjection(harness.databaseUrl, written.body.revision);
        await harness.restart();

        const replayedState = await api.request<DesiredStateResponse>(
          'GET',
          '/v1/settings/desired-state',
        );
        expect(replayedState.status).toBe(200);
        expect(replayedState.body.revision).toBe(written.body.revision);

        const replayedAgent = await api.request<AgentResponse>(
          'GET',
          `/v1/agents/${encodeURIComponent(AGENT_ID)}`,
        );
        expect(replayedAgent.status).toBe(200);
        expect(replayedAgent.body).toMatchObject({
          id: AGENT_ID,
          name: AGENT_NAME,
          status: 'active',
        });

        const installs = await api.request<{
          conversationInstalls: ConversationInstallResponse[];
        }>(
          'GET',
          `/v1/agents/${encodeURIComponent(AGENT_ID)}/conversation-installs`,
        );
        expect(installs.status).toBe(200);
        expect(installs.body.conversationInstalls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              agentId: AGENT_ID,
              providerAccountId: PROVIDER_ACCOUNT_ID,
              status: 'active',
            }),
          ]),
        );

        const access = await api.request<AgentAccessResponse>(
          'GET',
          `/v1/agents/${encodeURIComponent(AGENT_ID)}/access`,
        );
        expect(access.status).toBe(200);
        expect(access.body.agentId).toBe(AGENT_ID);
        expect(access.body.selections).toEqual(
          expect.arrayContaining([capability]),
        );

        const liveRoute = await api.request<ModelPreviewResponse>(
          'POST',
          '/v1/models/preview',
          {
            body: { target: 'chat', workspaceKey: AGENT_FOLDER },
          },
        );
        expect(liveRoute.status, JSON.stringify(liveRoute.body)).toBe(200);
        expect(liveRoute.body).toMatchObject({
          target: 'chat',
          scope: AGENT_FOLDER,
        });

        await durableProjection(harness.databaseUrl, written.body.revision);
      } catch (error) {
        sawFailure = true;
        throw error;
      }
    },
  );
});
