import { describe, expect, it, vi } from 'vitest';

import {
  DiscoverProviderConversationsService,
  ProviderConnectionControlService,
} from '@core/application/provider-conversations/provider-conversation-control-use-cases.js';
import { ApplicationError } from '@core/application/common/application-error.js';

const iso = '2026-05-02T00:00:00.000Z';

describe('ProviderConnectionControlService', () => {
  it('preserves null external refs when updating provider connections', async () => {
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'default',
      providerId: 'telegram',
      externalInstallationRef: {
        kind: 'provider_connection',
        value: 'stale-ref',
      },
      label: 'Telegram',
      status: 'active',
      config: {},
      runtimeSecretRefs: ['TELEGRAM_BOT_TOKEN'],
      createdAt: iso,
      updatedAt: iso,
    };
    const providerConnections = {
      getProviderConnection: vi.fn(async () => providerConnection),
      updateProviderConnection: vi.fn(async () => ({
        ...providerConnection,
        externalInstallationRef: undefined,
      })),
    };
    const service = new ProviderConnectionControlService({
      providerConnections: providerConnections as never,
      providers: { listProviders: vi.fn(async () => []) },
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await service.update({
      appId: 'default' as never,
      providerConnectionId: 'providerConnection-1' as never,
      patch: { externalInstallationRef: null },
    });

    expect(providerConnections.updateProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ externalInstallationRef: null }),
      }),
    );
  });
});

describe('DiscoverProviderConversationsService', () => {
  it('fails closed when discovered external ids use a mismatched explicit provider prefix', async () => {
    const service = new DiscoverProviderConversationsService({
      providerConnections: {
        getProviderConnection: vi.fn(async () => ({
          id: 'slack_default',
          appId: 'default',
          providerId: 'slack',
          label: 'Slack',
          status: 'active',
          config: {},
          runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
          createdAt: iso,
          updatedAt: iso,
        })),
      } as never,
      conversations: {
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => {}),
      } as never,
      discovery: {
        discover: vi.fn(async () => [
          {
            externalId: 'tg:-100123',
            kind: 'channel',
          },
        ]),
      },
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.execute({
        appId: 'default' as never,
        providerConnectionId: 'slack_default' as never,
      }),
    ).rejects.toBeInstanceOf(ApplicationError);
    await expect(
      service.execute({
        appId: 'default' as never,
        providerConnectionId: 'slack_default' as never,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});
