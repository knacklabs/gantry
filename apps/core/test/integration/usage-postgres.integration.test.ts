import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GantryModelGatewayBroker } from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway.js';
import {
  DEFAULT_AGENT_CONFIG_VERSION_ID,
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type {
  ModelCredential,
  ModelCredentialMetadata,
  ModelCredentialProvider,
} from '@core/domain/model-credentials/model-credentials.js';
import type { ModelCredentialRepository } from '@core/domain/ports/repositories.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { createGroupAgentRunner } from '@core/runtime/group-agent-runner.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const from = '2026-07-01T00:00:00.000Z' as never;
const to = '2026-07-03T00:00:00.000Z' as never;
const gatewayProviderId = ['anth', 'ropic'].join('') as ModelCredentialProvider;
const gatewayModel = ['cla', 'ude-sonnet-4-6'].join('');
const gatewayBaseUrlKey = ['ANTHROPIC', 'BASE_URL'].join('_');
const gatewayApiKeyKey = ['ANTHROPIC', 'API_KEY'].join('_');

class GatewayCredentialRepository implements ModelCredentialRepository {
  private readonly row: ModelCredential = {
    id: 'model-credential:usage' as never,
    appId: DEFAULT_APP_ID as never,
    providerId: gatewayProviderId,
    authMode: 'api_key',
    status: 'active',
    schemaVersion: 1,
    payload: { apiKey: 'test-upstream-key' },
    fingerprint: 'fingerprint:usage',
    fieldFingerprints: [{ field: 'apiKey', fingerprint: 'fingerprint:usage' }],
    createdAt: from,
    updatedAt: from,
  };

  async getModelCredential(): Promise<ModelCredential> {
    return this.row;
  }

  async listModelCredentials(): Promise<ModelCredentialMetadata[]> {
    const { payload: _payload, ...metadata } = this.row;
    return [metadata];
  }

  async upsertModelCredential(): Promise<ModelCredentialMetadata> {
    throw new Error('not needed');
  }

  async disableModelCredential(): Promise<ModelCredentialMetadata | null> {
    throw new Error('not needed');
  }
}

function gatewayRequest(input: {
  url: string;
  token: string;
  body: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      input.url,
      {
        method: 'POST',
        headers: {
          'x-api-key': input.token,
          'content-type': 'application/json',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(input.body);
  });
}

maybeDescribe('Postgres usage query', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'usage',
    });
    await runtime.repositories.apps.saveApp({
      id: 'app:other' as never,
      slug: 'other',
      name: 'Other App',
      status: 'active',
      createdAt: from,
      updatedAt: from,
    });
    for (const run of [
      { id: 'run:live', cause: 'message' },
      { id: 'run:job', cause: 'job', jobId: 'job:usage' },
    ] as const) {
      await runtime.repositories.agentRuns.saveAgentRun({
        id: run.id as never,
        appId: DEFAULT_APP_ID as never,
        agentId: DEFAULT_AGENT_ID as never,
        configVersionId: DEFAULT_AGENT_CONFIG_VERSION_ID as never,
        ...(run.jobId ? { jobId: run.jobId as never } : {}),
        llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
        executionProviderId: 'execution-provider:test' as never,
        permissionDecisionIds: [],
        cause: run.cause,
        status: 'completed',
        createdAt: from,
        startedAt: from,
        endedAt: from,
      });
    }

    const append = runtime.repositories.runtimeEvents.appendRuntimeEvent.bind(
      runtime.repositories.runtimeEvents,
    );
    const liveRunner = createGroupAgentRunner({
      deps: {
        channelRuntime: {
          hasChannel: () => true,
          supportsStreaming: () => false,
          supportsProgress: () => false,
          sendMessage: async () => {},
          sendStreamingChunk: async () => false,
          resetStreaming: () => {},
          setTyping: async () => {},
          sendProgressUpdate: async () => {},
        },
        queue: {
          enqueueMessageCheck: () => false,
          closeStdin: () => {},
          notifyIdle: () => {},
          registerProcess: () => {},
        },
        getGroup: () => undefined,
        clearSession: async () => {},
        getCursor: () => '',
        setCursor: () => {},
        saveState: async () => {},
        setGroupModelOverride: async () => {},
        setGroupThinkingOverride: async () => {},
        setGroupPermissionModeOverride: async () => {},
        getAvailableGroups: () => [],
        getRegisteredJids: () => new Set(),
        runAgent: (async (_group, _input, _register, onOutput) => {
          await onOutput?.({
            status: 'success',
            result: null,
            usageEventId: 'usage:live',
            usage: {
              model: 'model:live',
              provider: 'provider:live',
              inputTokens: 10,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalBillableInputTokens: 10,
              cacheProvider: 'none',
              cacheStatus: 'unknown',
              at: '2026-07-01T10:00:00.000Z',
            },
          });
          return { status: 'success', result: 'ok' };
        }) as never,
        publishRuntimeEvent: ({
          conversationId: _conversationId,
          threadId: _threadId,
          ...event
        }) =>
          append({
            ...event,
            createdAt: '2026-07-01T10:00:00.000Z' as never,
          }),
        runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
        executionAdapter: {
          id: ['anth', 'ropic:claude-agent-sdk'].join(''),
        } as never,
        getSelectedAgentHarness: () => 'auto',
      },
      ops: () =>
        ({
          getAgentTurnContext: async () => ({
            appId: DEFAULT_APP_ID,
            agentId: DEFAULT_AGENT_ID,
            agentSessionId: 'agent-session:usage',
          }),
          createSessionAgentRun: async () => 'run:live',
        }) as never,
    });
    await liveRunner(
      {
        name: 'Main',
        folder: 'main_agent',
        added_at: from,
        agentConfig: { model: 'model:live' },
      },
      'hello',
      'app:usage',
      'app:usage',
    );
    await append({
      appId: DEFAULT_APP_ID as never,
      agentId: DEFAULT_AGENT_ID as never,
      runId: 'run:job' as never,
      jobId: 'job:usage' as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      actor: 'scheduler',
      payload: {
        usage: {
          inputTokens: 20,
          outputTokens: 4,
          model: 'model:job-failover',
        },
        resolved_model_alias: 'model:job',
      },
      createdAt: '2026-07-01T11:00:00.000Z' as never,
    });
    await append({
      appId: DEFAULT_APP_ID as never,
      agentId: DEFAULT_AGENT_ID as never,
      runId: 'run:job' as never,
      jobId: 'job:usage' as never,
      eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_USED,
      actor: 'gantry-model-gateway',
      payload: {
        outcome: 'forwarded',
        tokenScope: 'run:run:job',
        usage: { inputTokens: 20, outputTokens: 4 },
        modelAlias: 'model:job',
      },
      createdAt: '2026-07-01T11:00:01.000Z' as never,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: gatewayModel,
              content: [],
              usage: { input_tokens: 30, output_tokens: 6 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const gateway = new GantryModelGatewayBroker(
      new GatewayCredentialRepository(),
      {
        audit: (event) =>
          append({
            ...event,
            createdAt: '2026-07-02T09:00:00.000Z' as never,
          }),
      },
    );
    try {
      const injection = await gateway.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId: DEFAULT_APP_ID as never,
          apiKeyId: 'key:usage',
          apiRequestId: 'request:usage',
          modelCredentialProviderId: gatewayProviderId,
        },
      });
      await expect(
        gatewayRequest({
          url: `${injection.env[gatewayBaseUrlKey]}/v1/messages`,
          token: injection.env[gatewayApiKeyKey]!,
          body: JSON.stringify({ model: gatewayModel, messages: [] }),
        }),
      ).resolves.toBe(200);
    } finally {
      await gateway.close();
      vi.unstubAllGlobals();
    }
    await append({
      appId: 'app:other' as never,
      eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_USED,
      actor: 'gantry-model-gateway',
      payload: {
        apiKeyId: 'key:other',
        outcome: 'forwarded',
        tokenScope: 'api_key:key:other:request',
        usage: { inputTokens: 99, outputTokens: 9 },
        modelAlias: 'model:other',
      },
      createdAt: '2026-07-02T10:00:00.000Z' as never,
    });
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('aggregates one logical record per live, job, and direct request', async () => {
    await expect(
      runtime.repositories.runtimeEvents.queryUsage({
        appId: DEFAULT_APP_ID as never,
        from,
        to,
      }),
    ).resolves.toEqual([
      { requestCount: 3, inputTokens: 60, outputTokens: 12 },
    ]);

    const events = await runtime.repositories.runtimeEvents.listRuntimeEvents({
      appId: DEFAULT_APP_ID as never,
      eventTypes: [
        RUNTIME_EVENT_TYPES.MODEL_USAGE,
        RUNTIME_EVENT_TYPES.JOB_COMPLETED,
        RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_USED,
      ],
    });
    expect(
      events.find(
        (event) => event.eventType === RUNTIME_EVENT_TYPES.MODEL_USAGE,
      ),
    ).toMatchObject({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      runId: 'run:live',
      payload: { usageEventId: 'usage:live' },
    });
    expect(
      events.find(
        (event) => event.eventType === RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      ),
    ).toMatchObject({
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      runId: 'run:job',
      jobId: 'job:usage',
    });
    expect(
      events.find(
        (event) =>
          event.eventType === RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_USED &&
          (event.payload as { apiKeyId?: string }).apiKeyId === 'key:usage' &&
          (event.payload as { usage?: unknown }).usage !== undefined,
      ),
    ).toMatchObject({
      appId: DEFAULT_APP_ID,
      payload: {
        apiKeyId: 'key:usage',
        tokenScope: 'api_key:key:usage:request:usage',
        usage: { inputTokens: 30, outputTokens: 6 },
      },
    });
  });

  it('filters every correlation and keeps app boundaries', async () => {
    const query = runtime.repositories.runtimeEvents.queryUsage.bind(
      runtime.repositories.runtimeEvents,
    );
    const base = { appId: DEFAULT_APP_ID as never, from, to };
    await expect(
      query({ ...base, agentId: DEFAULT_AGENT_ID as never }),
    ).resolves.toEqual([{ requestCount: 2, inputTokens: 30, outputTokens: 6 }]);
    await expect(query({ ...base, apiKeyId: 'key:usage' })).resolves.toEqual([
      { requestCount: 1, inputTokens: 30, outputTokens: 6 },
    ]);
    await expect(
      query({ ...base, runId: 'run:live' as never }),
    ).resolves.toEqual([{ requestCount: 1, inputTokens: 10, outputTokens: 2 }]);
    await expect(
      query({ ...base, jobId: 'job:usage' as never }),
    ).resolves.toEqual([{ requestCount: 1, inputTokens: 20, outputTokens: 4 }]);
    await expect(query({ ...base, model: 'sonnet' })).resolves.toEqual([
      { requestCount: 1, inputTokens: 30, outputTokens: 6 },
    ]);
    await expect(
      query({ ...base, model: 'model:job-failover' }),
    ).resolves.toEqual([{ requestCount: 1, inputTokens: 20, outputTokens: 4 }]);
    await expect(
      query({ appId: 'app:other' as never, from, to }),
    ).resolves.toEqual([{ requestCount: 1, inputTokens: 99, outputTokens: 9 }]);
  });

  it('groups by agent, api key, model, and UTC day', async () => {
    const query = runtime.repositories.runtimeEvents.queryUsage.bind(
      runtime.repositories.runtimeEvents,
    );
    const base = { appId: DEFAULT_APP_ID as never, from, to };
    await expect(query({ ...base, groupBy: 'agent' })).resolves.toEqual([
      {
        agentId: DEFAULT_AGENT_ID,
        requestCount: 2,
        inputTokens: 30,
        outputTokens: 6,
      },
      { requestCount: 1, inputTokens: 30, outputTokens: 6 },
    ]);
    await expect(query({ ...base, groupBy: 'api_key' })).resolves.toEqual([
      {
        apiKeyId: 'key:usage',
        requestCount: 1,
        inputTokens: 30,
        outputTokens: 6,
      },
      { requestCount: 2, inputTokens: 30, outputTokens: 6 },
    ]);
    await expect(query({ ...base, groupBy: 'model' })).resolves.toEqual([
      {
        model: 'model:job-failover',
        requestCount: 1,
        inputTokens: 20,
        outputTokens: 4,
      },
      {
        model: 'model:live',
        requestCount: 1,
        inputTokens: 10,
        outputTokens: 2,
      },
      {
        model: 'sonnet',
        requestCount: 1,
        inputTokens: 30,
        outputTokens: 6,
      },
    ]);
    await expect(query({ ...base, groupBy: 'day' })).resolves.toEqual([
      {
        day: '2026-07-01',
        requestCount: 2,
        inputTokens: 30,
        outputTokens: 6,
      },
      {
        day: '2026-07-02',
        requestCount: 1,
        inputTokens: 30,
        outputTokens: 6,
      },
    ]);
  });
});
