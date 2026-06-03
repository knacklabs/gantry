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

const APP_ID = 'default' as AppId;

describe('buildControlPlaneReadModelFromRepositories pending access count', () => {
  it('surfaces pending access approvals as the next action', async () => {
    const model = await buildControlPlaneReadModelFromRepositories({
      appId: APP_ID,
      settings: settings(),
      jobsRepository: { listJobs: async () => [] },
      modelCredentialsRepository: {
        listModelCredentials: async () =>
          [{ providerId: 'anthropic', status: 'active' }] as unknown as Awaited<
            ReturnType<
              BuilderInput['modelCredentialsRepository']['listModelCredentials']
            >
          >,
      },
      pendingAccessRequestsRepository: {
        countPendingAccessRequests: async () => 2,
      },
    });

    expect(model.access.needsApproval).toBe(2);
    expect(model.nextAction.kind).toBe('missing_access_approval');
  });
});
