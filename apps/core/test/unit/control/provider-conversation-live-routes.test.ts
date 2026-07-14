import { describe, expect, it, vi } from 'vitest';

import {
  projectProviderAccountRoutesToRuntime,
  removeProviderAccountRoutesFromRuntime,
} from '@core/control/server/routes/provider-conversation-live-routes.js';

const runtimeStore = vi.hoisted(() => ({
  repositories: {
    agents: {
      getAgent: vi.fn(),
    },
    conversations: {
      getConversation: vi.fn(),
      getThread: vi.fn(),
    },
    providerAccounts: {
      getProviderAccount: vi.fn(),
      listConversationInstalls: vi.fn(),
    },
  },
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => runtimeStore,
}));

describe('provider conversation live routes', () => {
  it('removes only routes for the disabled provider account', async () => {
    const unregisterConversationRoute = vi.fn(async () => undefined);
    const ctx = {
      app: {
        getConversationRoutes: vi.fn(() => ({
          'slack:C1::agent:agent%3Amain_agent::account:pa-active': {
            providerAccountId: 'provider-account:active',
          },
          'slack:C2::agent:agent%3Amain_agent::account:pa-disabled': {
            providerAccountId: 'provider-account:disabled',
          },
        })),
        unregisterConversationRoute,
      },
    } as any;

    await removeProviderAccountRoutesFromRuntime(
      ctx,
      'provider-account:disabled' as any,
    );

    expect(unregisterConversationRoute).toHaveBeenCalledOnce();
    expect(unregisterConversationRoute).toHaveBeenCalledWith(
      'slack:C2::agent:agent%3Amain_agent::account:pa-disabled',
    );
  });

  it('projects active installs when a provider account is re-enabled', async () => {
    const projectConversationRoute = vi.fn(async () => undefined);
    runtimeStore.repositories.providerAccounts.getProviderAccount.mockResolvedValue(
      {
        id: 'provider-account:enabled',
        appId: 'app-one',
        agentId: 'agent:main_agent',
        providerId: 'slack',
        status: 'active',
      },
    );
    runtimeStore.repositories.providerAccounts.listConversationInstalls.mockResolvedValue(
      [
        {
          id: 'install-enabled',
          appId: 'app-one',
          agentId: 'agent:main_agent',
          providerAccountId: 'provider-account:enabled',
          conversationId: 'conversation:C1',
          displayName: 'Team Channel',
          status: 'active',
          memorySubject: {},
          createdAt: '2026-04-24T00:00:00.000Z',
        },
        {
          id: 'install-other',
          appId: 'app-one',
          agentId: 'agent:main_agent',
          providerAccountId: 'provider-account:other',
          conversationId: 'conversation:C2',
          displayName: 'Other Channel',
          status: 'active',
          memorySubject: {},
          createdAt: '2026-04-24T00:00:00.000Z',
        },
      ],
    );
    runtimeStore.repositories.agents.getAgent.mockResolvedValue({
      id: 'agent:main_agent',
      name: 'Main Agent',
    });
    runtimeStore.repositories.conversations.getConversation.mockResolvedValue({
      id: 'conversation:C1',
      kind: 'channel',
      externalRef: { value: 'C1' },
    });

    await projectProviderAccountRoutesToRuntime(
      { app: { projectConversationRoute } } as any,
      'provider-account:enabled' as any,
    );

    expect(projectConversationRoute).toHaveBeenCalledOnce();
    expect(projectConversationRoute).toHaveBeenCalledWith(
      'C1',
      expect.objectContaining({
        providerAccountId: 'provider-account:enabled',
        conversationKind: 'channel',
      }),
    );
  });
});
