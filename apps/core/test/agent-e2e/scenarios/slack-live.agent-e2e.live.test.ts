// Protected real-Slack scenario. It deliberately uses Slack's Web API as the
// test actor: user token posts a root message, the isolated Gantry runtime
// receives it through Socket Mode, and the test reads the bot's thread reply.
// No reply wording is asserted.

import { afterAll, describe, expect, it } from 'vitest';

import { requireRealModelCredential } from '../fixtures/model-credential-fixture.js';
import {
  deleteSlackMessage,
  requireSlackLiveCredentials,
  sendSlackTestMessage,
  slackBotUserId,
  slackChannelIdByName,
  waitForSlackThreadReply,
} from '../fixtures/slack-live-fixture.js';
import { AgentE2EApiClient } from '../harness/api-client.js';
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
const slackCredential = requireSlackLiveCredentials();
const modelApiKey =
  'credential' in modelCredential ? modelCredential.credential : undefined;
const slack =
  'credentials' in slackCredential ? slackCredential.credentials : undefined;
const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
const maybeDescribe = modelApiKey && slack && hasDb ? describe : describe.skip;
const CHANNEL_NAME =
  process.env.E2E_SLACK_CHANNEL_NAME?.trim() || 'agent-e2e-channel';
const AGENT_FOLDER = 'e2e_live_slack';
const PROVIDER_ACCOUNT_ID = 'e2e_slack';
const CONVERSATION_KEY = 'e2e_live_slack_channel';
const ADDED_AT = '2026-08-31T00:00:00.000Z';
const TURN_TIMEOUT_MS = 180_000;

interface DesiredStateResponse {
  revision: number;
  settings: Record<string, unknown> | null;
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

maybeDescribe('agent-e2e Slack live channel (protected)', () => {
  let harness: RuntimeHarness | undefined;
  let evidence: EvidenceRun | undefined;
  let channelId = '';
  let rootTs = '';
  let replyTs = '';
  let sawFailure = false;

  afterAll(async () => {
    const secrets = [
      ...(harness?.secrets ?? []),
      ...(slack ? [slack.userToken, slack.botToken, slack.appToken] : []),
      ...(modelApiKey ? [modelApiKey] : []),
    ];
    if (sawFailure && harness && evidence) {
      evidence.evidence.redactedFailure = redactText(
        harness.logs().slice(-24000),
        secrets,
      ).slice(-4000);
    }
    if (!sawFailure && slack && channelId) {
      if (replyTs)
        await deleteSlackMessage({
          token: slack.botToken,
          channelId,
          ts: replyTs,
        });
      if (rootTs)
        await deleteSlackMessage({
          token: slack.userToken,
          channelId,
          ts: rootTs,
        });
    }
    evidence?.write(
      process.env.AGENT_E2E_EVIDENCE_DIR ?? '/tmp/gantry-agent-e2e-evidence',
    );
    await harness?.teardown({ failed: sawFailure });
  }, 60_000);

  it(
    "sends a real user message and receives Gantry's threaded Slack reply",
    { timeout: 360_000 },
    async () => {
      try {
        if (!slack || !modelApiKey)
          throw new Error('protected credentials missing');
        evidence = startEvidenceRun({
          scenario: 'slack-live',
          secrets: [
            slack.userToken,
            slack.botToken,
            slack.appToken,
            modelApiKey,
          ],
          provider: 'slack',
          modelAlias: 'haiku',
          harness: 'socket-mode',
        });
        evidence.phase('discover-channel');
        channelId = await slackChannelIdByName(slack.userToken, CHANNEL_NAME);
        const botUserId = await slackBotUserId(slack.botToken);

        evidence.phase('boot-runtime');
        harness = await startRuntimeHarness({
          scopes: ['agents:admin', 'credentials:admin'],
          env: {
            SLACK_BOT_TOKEN: slack.botToken,
            SLACK_APP_TOKEN: slack.appToken,
          },
        });
        const api = new AgentE2EApiClient(harness.baseUrl, harness.apiKey);
        const seeded = await api.request<{ status: string }>(
          'PUT',
          '/v1/credentials/models/anthropic',
          {
            body: modelApiKey.startsWith('sk-ant-api')
              ? { authMode: 'api_key', payload: { apiKey: modelApiKey } }
              : {
                  authMode: 'claude_code_oauth',
                  payload: { oauthToken: modelApiKey },
                },
          },
        );
        expect(seeded.status).toBe(200);
        const model = await api.request('PATCH', '/v1/models/defaults', {
          body: { chat: 'haiku' },
        });
        expect(model.status).toBe(200);

        const baseline = await api.request<DesiredStateResponse>(
          'GET',
          '/v1/settings/desired-state',
        );
        expect(baseline.status).toBe(200);
        if (!baseline.body.settings)
          throw new Error('Desired-state document is missing');
        const settings = structuredClone(baseline.body.settings);
        recordAt(settings, 'providers').slack = { enabled: true };
        recordAt(settings, 'provider_accounts')[PROVIDER_ACCOUNT_ID] = {
          agent: AGENT_FOLDER,
          provider: 'slack',
          label: 'Gantry E2E Slack',
          runtime_secret_refs: {
            bot_token: 'env:SLACK_BOT_TOKEN',
            app_token: 'env:SLACK_APP_TOKEN',
          },
        };
        recordAt(settings, 'agents')[AGENT_FOLDER] = {
          name: 'Gantry E2E Slack',
          access: {
            preset: 'full',
            sources: { skills: [], mcp_servers: [], tools: [] },
            selections: [],
          },
        };
        recordAt(settings, 'conversations')[CONVERSATION_KEY] = {
          provider_account: PROVIDER_ACCOUNT_ID,
          external_id: `sl:${channelId}`,
          kind: 'group',
          display_name: CHANNEL_NAME,
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
              note: 'agent-e2e live Slack',
            },
          },
        );
        expect(written.status).toBe(200);
        await harness.restart();

        evidence.phase('send-and-verify');
        const message = await sendSlackTestMessage({
          token: slack.userToken,
          channelId,
        });
        rootTs = message.ts;
        const reply = await waitForSlackThreadReply({
          token: slack.userToken,
          channelId,
          rootTs,
          botUserId,
          timeoutMs: TURN_TIMEOUT_MS,
        });
        replyTs = reply.ts;
        expect(reply.text.trim()).not.toBe('');
        evidence.evidence.provider = 'slack';
        evidence.evidence.modelRoute = 'haiku';
        evidence.finishPhases();
      } catch (error) {
        sawFailure = true;
        throw error;
      }
    },
  );
});
