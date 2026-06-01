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
    providerConnections: { telegram_default: { provider: 'telegram' } },
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
});
