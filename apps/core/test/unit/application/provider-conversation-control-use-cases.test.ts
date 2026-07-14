import { describe, expect, it, vi } from 'vitest';

import * as providerConversationControls from '@core/application/provider-conversations/provider-conversation-control-use-cases.js';
import { ApplicationError } from '@core/application/common/application-error.js';

const iso = '2026-05-02T00:00:00.000Z';
const DiscoverProviderConversationsService =
  providerConversationControls.DiscoverProviderConversationsService;
const ConversationInstallControlService =
  providerConversationControls.ConversationInstallControlService;
const ProviderAccountControlService =
  providerConversationControls.ProviderAccountControlService;

describe('ProviderAccountControlService', () => {
  it('preserves null external refs when updating provider accounts', async () => {
    const providerAccount = {
      id: 'provider-account-1',
      appId: 'default',
      agentId: 'main_agent',
      providerId: 'telegram',
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'stale-ref',
      },
      label: 'Telegram',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => providerAccount),
      updateProviderAccount: vi.fn(async () => ({
        ...providerAccount,
        externalIdentityRef: undefined,
      })),
    };
    const service = new ProviderAccountControlService({
      agents: { getAgent: vi.fn() } as never,
      providerAccounts: providerAccounts as never,
      providers: { listProviders: vi.fn(async () => []) },
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await service.update({
      appId: 'default' as never,
      providerAccountId: 'provider-account-1' as never,
      patch: { externalInstallationRef: null },
    });

    expect(providerAccounts.updateProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ externalIdentityRef: null }),
      }),
    );
  });

  it('accepts AWS Secrets Manager runtime refs with deployment-owned names', async () => {
    const providerAccount = {
      id: 'provider-account-1',
      appId: 'default',
      agentId: 'main_agent',
      providerId: 'slack',
      externalIdentityRef: undefined,
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => providerAccount),
      updateProviderAccount: vi.fn(async () => providerAccount),
    };
    const service = new ProviderAccountControlService({
      agents: { getAgent: vi.fn() } as never,
      providerAccounts: providerAccounts as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            allowedRuntimeSecretKeys: ['bot_token', 'app_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await service.update({
      appId: 'default' as never,
      providerAccountId: 'provider-account-1' as never,
      patch: {
        runtimeSecretRefs: { bot_token: 'aws-sm:prod/slack/bot' },
      },
    });

    expect(providerAccounts.updateProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          runtimeSecretRefs: { bot_token: 'aws-sm:prod/slack/bot' },
        }),
      }),
    );
  });

  it('accepts custom env runtime refs for provider secret slots', async () => {
    const providerAccount = {
      id: 'provider-account-1',
      appId: 'default',
      agentId: 'main_agent',
      providerId: 'slack',
      externalIdentityRef: undefined,
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => providerAccount),
      updateProviderAccount: vi.fn(async () => providerAccount),
    };
    const service = new ProviderAccountControlService({
      agents: { getAgent: vi.fn() } as never,
      providerAccounts: providerAccounts as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            allowedRuntimeSecretKeys: ['bot_token', 'app_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await service.update({
      appId: 'default' as never,
      providerAccountId: 'provider-account-1' as never,
      patch: {
        runtimeSecretRefs: { bot_token: 'env:CUSTOM_SLACK_BOT_TOKEN' },
      },
    });

    expect(providerAccounts.updateProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          runtimeSecretRefs: { bot_token: 'env:CUSTOM_SLACK_BOT_TOKEN' },
        }),
      }),
    );
  });

  it('rejects forbidden env runtime refs before saving provider accounts', async () => {
    const providerAccount = {
      id: 'provider-account-1',
      appId: 'default',
      agentId: 'main_agent',
      providerId: 'slack',
      externalIdentityRef: undefined,
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => providerAccount),
      updateProviderAccount: vi.fn(async () => providerAccount),
    };
    const service = new ProviderAccountControlService({
      agents: { getAgent: vi.fn() } as never,
      providerAccounts: providerAccounts as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            allowedRuntimeSecretKeys: ['bot_token', 'app_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.update({
        appId: 'default' as never,
        providerAccountId: 'provider-account-1' as never,
        patch: {
          runtimeSecretRefs: { bot_token: 'env:OPENAI_API_KEY' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('OPENAI_API_KEY is not allowed'),
    });
    expect(providerAccounts.updateProviderAccount).not.toHaveBeenCalled();
  });

  it('rejects unrelated env runtime refs before saving provider accounts', async () => {
    const providerAccount = {
      id: 'provider-account-1',
      appId: 'default',
      agentId: 'main_agent',
      providerId: 'slack',
      externalIdentityRef: undefined,
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => providerAccount),
      updateProviderAccount: vi.fn(async () => providerAccount),
    };
    const service = new ProviderAccountControlService({
      agents: { getAgent: vi.fn() } as never,
      providerAccounts: providerAccounts as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            allowedRuntimeSecretKeys: ['bot_token', 'app_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.update({
        appId: 'default' as never,
        providerAccountId: 'provider-account-1' as never,
        patch: {
          runtimeSecretRefs: { bot_token: 'env:SECRET_ENCRYPTION_KEY' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining(
        'must point to the canonical slack credential for bot_token',
      ),
    });
    expect(providerAccounts.updateProviderAccount).not.toHaveBeenCalled();
  });

  it('rejects provider account creation for another app agent', async () => {
    const providerAccounts = {
      saveProviderAccount: vi.fn(async () => {}),
    };
    const service = new ProviderAccountControlService({
      agents: {
        getAgent: vi.fn(async () => ({
          id: 'other_agent',
          appId: 'other_app',
        })),
      } as never,
      providerAccounts: providerAccounts as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            capabilityFlags: [],
            allowedRuntimeSecretKeys: ['bot_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.create({
        appId: 'default' as never,
        agentId: 'other_agent' as never,
        providerId: 'slack' as never,
        label: 'Slack',
        runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(providerAccounts.saveProviderAccount).not.toHaveBeenCalled();
  });
});

describe('DiscoverProviderConversationsService', () => {
  it('fails closed when discovered external ids use a mismatched explicit provider prefix', async () => {
    const service = new DiscoverProviderConversationsService({
      providerAccounts: {
        getProviderAccount: vi.fn(async () => ({
          id: 'slack_default',
          appId: 'default',
          agentId: 'main_agent',
          providerId: 'slack',
          label: 'Slack',
          status: 'active',
          config: {},
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
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
        providerAccountId: 'slack_default' as never,
      }),
    ).rejects.toBeInstanceOf(ApplicationError);
    await expect(
      service.execute({
        appId: 'default' as never,
        providerAccountId: 'slack_default' as never,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('ConversationInstallControlService', () => {
  it('preserves route metadata when updating an existing install', async () => {
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => ({
        id: 'slack_alpha',
        appId: 'default',
        agentId: 'main_agent',
      })),
      getConversationInstall: vi.fn(async () => ({
        id: 'install-1',
        appId: 'default',
        agentId: 'main_agent',
        providerAccountId: 'slack_alpha',
        conversationId: 'conversation-1',
        displayName: 'shared',
        status: 'active',
        senderPolicy: 'provider_native',
        controlPolicy: 'conversation_approvers',
        memoryScope: 'conversation',
        memorySubject: {
          kind: 'conversation',
          appId: 'default',
          conversationId: 'conversation-1',
          route: { trigger: '@main', requiresTrigger: true },
        },
        permissionPolicyIds: [],
        createdAt: iso,
        updatedAt: iso,
      })),
      saveConversationInstall: vi.fn(async () => {}),
    };
    const service = new ConversationInstallControlService({
      agents: {
        getAgent: vi.fn(async () => ({
          id: 'main_agent',
          appId: 'default',
        })),
      },
      providerAccounts: providerAccounts as never,
      conversations: {
        getConversation: vi.fn(async () => ({
          id: 'conversation-1',
          appId: 'default',
          providerAccountId: 'slack_alpha',
          title: 'shared',
        })),
      } as never,
      ids: { generate: vi.fn(() => 'unused') },
      clock: { now: () => iso },
    });

    await service.enable({
      appId: 'default' as never,
      agentId: 'main_agent' as never,
      conversationId: 'conversation-1' as never,
      requireExisting: true,
      patch: { displayName: 'renamed' },
    });

    expect(providerAccounts.saveConversationInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'renamed',
        memorySubject: expect.objectContaining({
          route: { trigger: '@main', requiresTrigger: true },
        }),
      }),
    );
  });

  it('writes route config onto install memory subject', async () => {
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => ({
        id: 'slack_alpha',
        appId: 'default',
        agentId: 'main_agent',
      })),
      getConversationInstall: vi.fn(async () => null),
      saveConversationInstall: vi.fn(async () => {}),
    };
    const service = new ConversationInstallControlService({
      agents: {
        getAgent: vi.fn(async () => ({
          id: 'main_agent',
          appId: 'default',
        })),
      },
      providerAccounts: providerAccounts as never,
      conversations: {
        getConversation: vi.fn(async () => ({
          id: 'conversation-1',
          appId: 'default',
          providerAccountId: 'slack_alpha',
          title: 'shared',
        })),
      } as never,
      ids: { generate: vi.fn(() => 'install-1') },
      clock: { now: () => iso },
    });

    await service.enable({
      appId: 'default' as never,
      agentId: 'main_agent' as never,
      conversationId: 'conversation-1' as never,
      patch: {
        routeConfig: {
          trigger: '/ask',
          requiresTrigger: true,
          agentConfig: { model: 'sonnet' },
        },
      },
    });

    expect(providerAccounts.saveConversationInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySubject: expect.objectContaining({
          route: {
            trigger: '/ask',
            requiresTrigger: true,
            agentConfig: { model: 'sonnet' },
          },
        }),
      }),
    );
  });

  it('merges route config patches onto existing route metadata', async () => {
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => ({
        id: 'slack_alpha',
        appId: 'default',
        agentId: 'main_agent',
      })),
      getConversationInstall: vi.fn(async () => ({
        id: 'install-1',
        appId: 'default',
        agentId: 'main_agent',
        providerAccountId: 'slack_alpha',
        conversationId: 'conversation-1',
        displayName: 'shared',
        status: 'active',
        senderPolicy: 'provider_native',
        controlPolicy: 'conversation_approvers',
        memoryScope: 'conversation',
        memorySubject: {
          kind: 'conversation',
          appId: 'default',
          conversationId: 'conversation-1',
          route: {
            trigger: '@main',
            requiresTrigger: true,
            agentConfig: { model: 'sonnet' },
          },
        },
        permissionPolicyIds: [],
        createdAt: iso,
        updatedAt: iso,
      })),
      saveConversationInstall: vi.fn(async () => {}),
    };
    const service = new ConversationInstallControlService({
      agents: {
        getAgent: vi.fn(async () => ({
          id: 'main_agent',
          appId: 'default',
        })),
      },
      providerAccounts: providerAccounts as never,
      conversations: {
        getConversation: vi.fn(async () => ({
          id: 'conversation-1',
          appId: 'default',
          providerAccountId: 'slack_alpha',
          title: 'shared',
        })),
      } as never,
      ids: { generate: vi.fn(() => 'unused') },
      clock: { now: () => iso },
    });

    await service.enable({
      appId: 'default' as never,
      agentId: 'main_agent' as never,
      conversationId: 'conversation-1' as never,
      requireExisting: true,
      patch: { routeConfig: { trigger: '/ask' } },
    });

    expect(providerAccounts.saveConversationInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySubject: expect.objectContaining({
          route: {
            trigger: '/ask',
            requiresTrigger: true,
            agentConfig: { model: 'sonnet' },
          },
        }),
      }),
    );
  });

  it('requires exact thread install lookup when enabling a thread install', async () => {
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => ({
        id: 'slack_alpha',
        appId: 'default',
        agentId: 'main_agent',
      })),
      getConversationInstall: vi.fn(async () => null),
      saveConversationInstall: vi.fn(async () => {}),
    };
    const service = new ConversationInstallControlService({
      agents: {
        getAgent: vi.fn(async () => ({
          id: 'main_agent',
          appId: 'default',
        })),
      },
      providerAccounts: providerAccounts as never,
      conversations: {
        getConversation: vi.fn(async () => ({
          id: 'conversation-1',
          appId: 'default',
          providerAccountId: 'slack_alpha',
          title: 'shared',
        })),
        getThread: vi.fn(async () => ({
          id: 'thread-1',
          conversationId: 'conversation-1',
        })),
      } as never,
      ids: { generate: vi.fn(() => 'install-thread') },
      clock: { now: () => iso },
    });

    await service.enable({
      appId: 'default' as never,
      agentId: 'main_agent' as never,
      conversationId: 'conversation-1' as never,
      patch: { threadId: 'thread-1' as never },
    });

    expect(providerAccounts.getConversationInstall).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'main_agent',
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      exactThreadId: true,
    });
    expect(providerAccounts.saveConversationInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'install-thread',
        threadId: 'thread-1',
      }),
    );
  });

  it('rejects installs that move a conversation to another provider account', async () => {
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => null),
      getConversationInstall: vi.fn(async () => null),
      saveConversationInstall: vi.fn(async () => {}),
    };
    const service = new ConversationInstallControlService({
      agents: {
        getAgent: vi.fn(async () => ({
          id: 'main_agent',
          appId: 'default',
        })),
      },
      providerAccounts: providerAccounts as never,
      conversations: {
        getConversation: vi.fn(async () => ({
          id: 'conversation-1',
          appId: 'default',
          providerAccountId: 'slack_alpha',
          title: 'shared',
        })),
      } as never,
      ids: { generate: vi.fn(() => 'install-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.enable({
        appId: 'default' as never,
        agentId: 'main_agent' as never,
        conversationId: 'conversation-1' as never,
        patch: { providerAccountId: 'slack_beta' as never },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('must match'),
    });
    expect(providerAccounts.getProviderAccount).not.toHaveBeenCalled();
    expect(providerAccounts.saveConversationInstall).not.toHaveBeenCalled();
  });

  it('rejects installs when the provider account belongs to another agent', async () => {
    const providerAccounts = {
      getProviderAccount: vi.fn(async () => ({
        id: 'slack_alpha',
        appId: 'default',
        agentId: 'other_agent',
      })),
      getConversationInstall: vi.fn(async () => null),
      saveConversationInstall: vi.fn(async () => {}),
    };
    const service = new ConversationInstallControlService({
      agents: {
        getAgent: vi.fn(async () => ({
          id: 'main_agent',
          appId: 'default',
        })),
      },
      providerAccounts: providerAccounts as never,
      conversations: {
        getConversation: vi.fn(async () => ({
          id: 'conversation-1',
          appId: 'default',
          providerAccountId: 'slack_alpha',
          title: 'shared',
        })),
      } as never,
      ids: { generate: vi.fn(() => 'install-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.enable({
        appId: 'default' as never,
        agentId: 'main_agent' as never,
        conversationId: 'conversation-1' as never,
        patch: {},
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('different agent'),
    });
    expect(providerAccounts.saveConversationInstall).not.toHaveBeenCalled();
  });
});
