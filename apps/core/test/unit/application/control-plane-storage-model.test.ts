import { describe, expect, it } from 'vitest';

import { buildControlPlaneReadModelFromRepositories } from '@core/application/control-plane/control-plane-storage-model.js';
import type { AppId } from '@core/domain/app/app.js';

type BuilderInput = Parameters<
  typeof buildControlPlaneReadModelFromRepositories
>[0];

function settings(): BuilderInput['settings'] {
  return {
    agent: {
      name: 'Agent',
      defaultModel: 'opus',
      oneTimeJobDefaultModel: 'opus',
      recurringJobDefaultModel: 'opus',
    },
    agents: {
      agent: { name: 'Agent', model: 'opus', capabilities: [] },
    },
    conversations: { conv: {} },
    bindings: { binding: { agent: 'agent', conversation: 'conv' } },
    providers: { telegram: { enabled: true } },
    providerAccounts: { telegram_default: { provider: 'telegram' } },
    memory: { enabled: false },
  } as unknown as BuilderInput['settings'];
}

function repos(
  credentialProviders: Array<{ providerId: string; status: string }>,
): Pick<
  BuilderInput,
  | 'jobsRepository'
  | 'modelCredentialsRepository'
  | 'pendingAccessRequestsRepository'
> {
  return {
    jobsRepository: { listJobs: async () => [] },
    modelCredentialsRepository: {
      listModelCredentials: async () =>
        credentialProviders as unknown as Awaited<
          ReturnType<
            BuilderInput['modelCredentialsRepository']['listModelCredentials']
          >
        >,
    },
    pendingAccessRequestsRepository: {
      countPendingAccessRequests: async () => 0,
    },
  };
}

const APP_ID = 'default' as AppId;

describe('buildControlPlaneReadModelFromRepositories model credential readiness', () => {
  it('is ready when every required provider has an active credential', async () => {
    const model = await buildControlPlaneReadModelFromRepositories({
      appId: APP_ID,
      settings: settings(),
      ...repos([{ providerId: 'anthropic', status: 'active' }]),
    });
    // opus -> anthropic; active anthropic credential satisfies the requirement.
    expect(model.nextAction.kind).not.toBe('missing_model_credential');
  });

  it('is not ready when the required provider credential is not active', async () => {
    const model = await buildControlPlaneReadModelFromRepositories({
      appId: APP_ID,
      settings: settings(),
      ...repos([{ providerId: 'anthropic', status: 'disabled' }]),
    });
    expect(model.nextAction.kind).toBe('missing_model_credential');
  });

  it('is not ready when an active credential exists for a different provider', async () => {
    const model = await buildControlPlaneReadModelFromRepositories({
      appId: APP_ID,
      settings: settings(),
      ...repos([{ providerId: 'openai', status: 'active' }]),
    });
    // "any active credential" would have passed here; provider-specific
    // readiness must still flag the missing anthropic credential.
    expect(model.nextAction.kind).toBe('missing_model_credential');
  });

  it('counts default runtime jobs through the same host-owned scope as job listing', async () => {
    const jobs = [
      {
        id: 'host-owned',
        status: 'active',
        workspace_key: 'main_agent',
        session_id: null,
        execution_context: { conversationJid: 'tg:main' },
      },
      {
        id: 'default-session',
        status: 'paused',
        workspace_key: 'main_agent',
        session_id: 'session-default',
        execution_context: { conversationJid: 'tg:default' },
      },
      {
        id: 'other-app',
        status: 'active',
        workspace_key: 'other_agent',
        session_id: 'session-other',
        execution_context: { conversationJid: 'tg:other' },
      },
    ];
    const filters: unknown[] = [];
    const model = await buildControlPlaneReadModelFromRepositories({
      appId: APP_ID,
      settings: settings(),
      ...repos([{ providerId: 'anthropic', status: 'active' }]),
      jobsRepository: {
        listJobs: async (input) => {
          filters.push(input);
          return jobs as unknown as Awaited<
            ReturnType<BuilderInput['jobsRepository']['listJobs']>
          >;
        },
      },
      jobControlRepository: {
        getAppSessionsByIds: async () => [
          {
            sessionId: 'session-default',
            appId: 'default',
            conversationJid: 'tg:default',
            workspaceKey: 'main_agent',
            defaultResponseMode: 'none',
            defaultWebhookId: null,
          },
          {
            sessionId: 'session-other',
            appId: 'other',
            conversationJid: 'tg:other',
            workspaceKey: 'other_agent',
            defaultResponseMode: 'none',
            defaultWebhookId: null,
          },
        ],
        getAppSessionByChatJid: async () => undefined,
        getAppSessionsByChatJids: async () => [],
      },
    });

    expect(filters).toEqual([{}]);
    expect(model.jobs).toEqual({ ready: 1, needsAction: 1, blocked: 0 });
  });

  it('includes host-owned default jobs when no control lookup is available', async () => {
    const filters: unknown[] = [];
    const model = await buildControlPlaneReadModelFromRepositories({
      appId: APP_ID,
      settings: settings(),
      ...repos([{ providerId: 'anthropic', status: 'active' }]),
      jobsRepository: {
        listJobs: async (input) => {
          filters.push(input);
          return [
            {
              id: 'host-owned-needs-action',
              status: 'paused',
              workspace_key: 'main_agent',
              session_id: null,
              execution_context: { conversationJid: 'tg:main' },
            },
          ] as unknown as Awaited<
            ReturnType<BuilderInput['jobsRepository']['listJobs']>
          >;
        },
      },
    });

    expect(filters).toEqual([{}]);
    expect(model.jobs).toEqual({ ready: 0, needsAction: 1, blocked: 0 });
    expect(model.nextAction).toMatchObject({
      kind: 'blocked_job',
      params: { jobId: 'host-owned-needs-action' },
    });
  });
});
