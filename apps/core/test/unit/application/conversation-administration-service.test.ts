import { describe, expect, it, vi } from 'vitest';

import {
  ConversationAdministrationService,
  type ConversationMembershipValidator,
} from '@core/application/provider-conversations/conversation-administration-service.js';

const iso = '2026-05-01T00:00:00.000Z';

function makeService(options?: {
  validUserIds?: string[];
  participantUserIds?: string[];
  providerId?: string;
  conversationKind?: 'group' | 'channel' | 'direct';
}) {
  const providerAccount = {
    id: 'provider-account-1',
    appId: 'default',
    agentId: 'agent:main',
    providerId: options?.providerId ?? 'telegram',
    label: 'Telegram',
    status: 'active',
    config: {},
    runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
    createdAt: iso,
    updatedAt: iso,
  };
  const conversation = {
    id: 'conversation-1',
    appId: 'default',
    providerAccountId: 'provider-account-1',
    externalRef: { kind: 'conversation', value: 'tg:-100123' },
    kind: options?.conversationKind ?? 'group',
    title: 'Team',
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
  };
  const storedApprovers: string[] = [];
  const repositories = {
    providerAccounts: {
      getProviderAccount: vi.fn(async () => providerAccount),
      updateProviderAccount: vi.fn(async (input: any) => ({
        ...providerAccount,
        config: input.patch.config,
      })),
    },
    conversations: {
      getConversation: vi.fn(async (id: string) =>
        id === conversation.id ? conversation : null,
      ),
      getConversationByExternalRef: vi.fn(async (input: any) =>
        input.providerAccountId === conversation.providerAccountId &&
        input.externalConversationId === 'tg:-100123'
          ? conversation
          : null,
      ),
      findConversationByExternalValue: vi.fn(async (input: any) =>
        input.externalConversationId === 'tg:-100123' ? conversation : null,
      ),
      listParticipantExternalUserIds: vi.fn(
        async () => options?.participantUserIds ?? [],
      ),
      listConversationApprovers: vi.fn(async () =>
        storedApprovers.map((externalUserId) => ({
          id: `approver:${externalUserId}`,
          appId: 'default',
          conversationId: conversation.id,
          externalUserId,
          createdAt: iso,
          updatedAt: iso,
        })),
      ),
      replaceConversationApprovers: vi.fn(async (input: any) => {
        storedApprovers.splice(
          0,
          storedApprovers.length,
          ...input.externalUserIds,
        );
        return storedApprovers.map((externalUserId) => ({
          id: `approver:${externalUserId}`,
          appId: 'default',
          conversationId: conversation.id,
          externalUserId,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        }));
      }),
    },
  };
  const validator: ConversationMembershipValidator | undefined =
    options?.validUserIds
      ? {
          validateControlApprovers: vi.fn(async (input) => ({
            validUserIds: input.userIds.filter((id) =>
              options.validUserIds?.includes(id),
            ),
            invalidUserIds: input.userIds.filter(
              (id) => !options.validUserIds?.includes(id),
            ),
          })),
        }
      : undefined;
  return {
    service: new ConversationAdministrationService(
      repositories as never,
      validator,
    ),
    repositories,
  };
}

describe('ConversationAdministrationService', () => {
  it('replaces conversation approvers deterministically', async () => {
    const { service, repositories } = makeService({
      validUserIds: ['123', '456'],
    });

    const result = await service.replaceControlAllowlist({
      appId: 'default' as never,
      conversationId: 'conversation-1' as never,
      userIds: ['456', '123', '123'],
      updatedAt: iso,
    });

    expect(result).toEqual({ userIds: ['123', '456'] });
    expect(
      repositories.conversations.replaceConversationApprovers,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserIds: ['123', '456'] }),
    );
  });

  it('rejects control approvers that are not conversation members', async () => {
    const { service, repositories } = makeService({ validUserIds: ['123'] });

    await expect(
      service.replaceControlAllowlist({
        appId: 'default' as never,
        conversationId: 'conversation-1' as never,
        userIds: ['123', '999'],
        updatedAt: iso,
      }),
    ).rejects.toThrow(/Control approvers must be members/);
    expect(
      repositories.conversations.replaceConversationApprovers,
    ).not.toHaveBeenCalled();
  });

  it('returns only conversation-owned control approvers in admin summary', async () => {
    const { service } = makeService({ validUserIds: ['123'] });

    await service.replaceControlAllowlist({
      appId: 'default' as never,
      conversationId: 'conversation-1' as never,
      userIds: ['123'],
      updatedAt: iso,
    });
    const summary = await service.getAdminSummary({
      appId: 'default' as never,
      conversationId: 'conversation-1' as never,
    });

    expect(summary.controlAllowlist.userIds).toEqual(['123']);
  });

  it('validates app and web approvers against known participants', async () => {
    const { service, repositories } = makeService({
      providerId: 'app',
      participantUserIds: ['member-1'],
      validUserIds: ['not-used'],
    });

    await expect(
      service.replaceControlAllowlist({
        appId: 'default' as never,
        conversationId: 'conversation-1' as never,
        userIds: ['member-1', 'outsider-1'],
        updatedAt: iso,
      }),
    ).rejects.toThrow(/Control approvers must be members/);
    expect(
      repositories.conversations.listParticipantExternalUserIds,
    ).toHaveBeenCalledWith('conversation-1');
    expect(
      repositories.conversations.replaceConversationApprovers,
    ).not.toHaveBeenCalled();
  });

  it('allows control allowlist updates for direct conversations', async () => {
    const { service, repositories } = makeService({
      providerId: 'slack',
      conversationKind: 'direct',
      validUserIds: ['U123'],
    });

    await expect(
      service.replaceControlAllowlist({
        appId: 'default' as never,
        conversationId: 'conversation-1' as never,
        userIds: ['U123'],
        updatedAt: iso,
      }),
    ).resolves.toEqual({ userIds: ['U123'] });
    expect(
      repositories.conversations.replaceConversationApprovers,
    ).toHaveBeenCalled();
  });

  it('keeps approvers scoped to the origin conversation provider', async () => {
    const providerAccounts = new Map([
      [
        'provider-account-slack',
        {
          id: 'provider-account-slack',
          appId: 'default',
          agentId: 'agent:main',
          providerId: 'slack',
          label: 'Slack',
          status: 'active',
          config: {},
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
          createdAt: iso,
          updatedAt: iso,
        },
      ],
      [
        'provider-account-teams',
        {
          id: 'provider-account-teams',
          appId: 'default',
          agentId: 'agent:main',
          providerId: 'teams',
          label: 'Teams',
          status: 'active',
          config: {},
          runtimeSecretRefs: { client_id: 'env:TEAMS_CLIENT_ID' },
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    ]);
    const conversations = new Map([
      [
        'conversation:slack:C123',
        {
          id: 'conversation:slack:C123',
          appId: 'default',
          providerAccountId: 'provider-account-slack',
          externalRef: { kind: 'conversation', value: 'slack:C123' },
          kind: 'channel',
          title: 'Sales Slack',
          status: 'active',
          createdAt: iso,
          updatedAt: iso,
        },
      ],
      [
        'conversation:teams:19:channel@thread.tacv2',
        {
          id: 'conversation:teams:19:channel@thread.tacv2',
          appId: 'default',
          providerAccountId: 'provider-account-teams',
          externalRef: {
            kind: 'conversation',
            value: 'teams:19:channel@thread.tacv2',
          },
          kind: 'channel',
          title: 'Sales Teams',
          status: 'active',
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    ]);
    const storedApprovers = new Map<string, string[]>();
    const repositories = {
      providerAccounts: {
        getProviderAccount: vi.fn(async (id: string) =>
          providerAccounts.get(id),
        ),
        getConversationInstall: vi.fn(async (input: any) => ({
          id: `install:${input.agentId}:${input.conversationId}`,
          appId: input.appId,
          agentId: input.agentId,
          providerAccountId: [...conversations.values()].find(
            (conversation) => conversation.id === input.conversationId,
          )?.providerAccountId,
          conversationId: input.conversationId,
          displayName: 'Install',
          status: 'active',
          senderPolicy: 'provider_native',
          controlPolicy: 'conversation_approvers',
          memoryScope: 'conversation',
          memorySubject: {
            appId: input.appId,
            agentId: input.agentId,
            subjectType: 'conversation',
            subjectId: input.conversationId,
          },
          permissionPolicyIds: [],
          createdAt: iso,
          updatedAt: iso,
        })),
      },
      conversations: {
        getConversation: vi.fn(async (id: string) => conversations.get(id)),
        getConversationByExternalRef: vi.fn(async (input: any) =>
          [...conversations.values()].find(
            (conversation) =>
              conversation.providerAccountId === input.providerAccountId &&
              conversation.externalRef.value === input.externalConversationId,
          ),
        ),
        findConversationByExternalValue: vi.fn(async (input: any) =>
          [...conversations.values()].find(
            (conversation) =>
              conversation.externalRef.value === input.externalConversationId,
          ),
        ),
        listParticipantExternalUserIds: vi.fn(async () => ['admin']),
        listConversationApprovers: vi.fn(async (conversationId: string) =>
          (storedApprovers.get(conversationId) ?? []).map((externalUserId) => ({
            id: `approver:${conversationId}:${externalUserId}`,
            appId: 'default',
            conversationId,
            externalUserId,
            createdAt: iso,
            updatedAt: iso,
          })),
        ),
        replaceConversationApprovers: vi.fn(async (input: any) => {
          storedApprovers.set(input.conversationId, input.externalUserIds);
          return input.externalUserIds.map((externalUserId: string) => ({
            id: `approver:${input.conversationId}:${externalUserId}`,
            appId: 'default',
            conversationId: input.conversationId,
            externalUserId,
            createdAt: input.updatedAt,
            updatedAt: input.updatedAt,
          }));
        }),
      },
    };
    const validator: ConversationMembershipValidator = {
      validateControlApprovers: vi.fn(async (input) => {
        const validByProvider = new Map([
          ['slack', new Set(['UADMIN'])],
          ['teams', new Set(['8:orgid:admin'])],
        ]);
        const valid =
          validByProvider.get(String(input.providerId)) ?? new Set();
        return {
          validUserIds: input.userIds.filter((id) => valid.has(id)),
          invalidUserIds: input.userIds.filter((id) => !valid.has(id)),
        };
      }),
    };
    const service = new ConversationAdministrationService(
      repositories as never,
      validator,
    );

    await service.replaceControlAllowlist({
      appId: 'default' as never,
      conversationId: 'conversation:slack:C123' as never,
      userIds: ['UADMIN'],
      updatedAt: iso,
    });
    await service.replaceControlAllowlist({
      appId: 'default' as never,
      conversationId: 'conversation:teams:19:channel@thread.tacv2' as never,
      userIds: ['8:orgid:admin'],
      updatedAt: iso,
    });

    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack' as never,
        providerAccountId: 'provider-account-slack' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'slack:C123',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'teams' as never,
        providerAccountId: 'provider-account-teams' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'teams:19:channel@thread.tacv2',
        userId: '8:orgid:admin',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'teams' as never,
        providerAccountId: 'provider-account-teams' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'teams:19:channel@thread.tacv2',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(false);
    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack' as never,
        providerAccountId: 'provider-account-slack' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'slack:C123',
        userId: '8:orgid:admin',
      }),
    ).resolves.toBe(false);
  });

  it('finds prefixless stored conversations from provider-specific JID prefixes', async () => {
    const providerAccounts = new Map([
      [
        'provider-account-telegram',
        {
          id: 'provider-account-telegram',
          appId: 'default',
          agentId: 'agent:main',
          providerId: 'telegram',
          label: 'Telegram',
          status: 'active',
          config: {},
          runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
          createdAt: iso,
          updatedAt: iso,
        },
      ],
      [
        'provider-account-slack',
        {
          id: 'provider-account-slack',
          appId: 'default',
          agentId: 'agent:main',
          providerId: 'slack',
          label: 'Slack',
          status: 'active',
          config: {},
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    ]);
    const conversations = new Map([
      [
        '-100123',
        {
          id: 'conversation:telegram:-100123',
          appId: 'default',
          providerAccountId: 'provider-account-telegram',
          externalRef: { kind: 'conversation', value: '-100123' },
          kind: 'group',
          title: 'Telegram Group',
          status: 'active',
          createdAt: iso,
          updatedAt: iso,
        },
      ],
      [
        'C123',
        {
          id: 'conversation:slack:C123',
          appId: 'default',
          providerAccountId: 'provider-account-slack',
          externalRef: { kind: 'conversation', value: 'C123' },
          kind: 'channel',
          title: 'Slack Channel',
          status: 'active',
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    ]);
    const repositories = {
      providerAccounts: {
        getProviderAccount: vi.fn(async (id: string) =>
          providerAccounts.get(id),
        ),
        getConversationInstall: vi.fn(async (input: any) => ({
          id: `install:${input.agentId}:${input.conversationId}`,
          appId: input.appId,
          agentId: input.agentId,
          providerAccountId: [...conversations.values()].find(
            (conversation) => conversation.id === input.conversationId,
          )?.providerAccountId,
          conversationId: input.conversationId,
          displayName: 'Install',
          status: 'active',
          senderPolicy: 'provider_native',
          controlPolicy: 'conversation_approvers',
          memoryScope: 'conversation',
          memorySubject: {
            appId: input.appId,
            agentId: input.agentId,
            subjectType: 'conversation',
            subjectId: input.conversationId,
          },
          permissionPolicyIds: [],
          createdAt: iso,
          updatedAt: iso,
        })),
      },
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(
          async (input: any) =>
            conversations.get(input.externalConversationId) ?? null,
        ),
        findConversationByExternalValue: vi.fn(
          async (input: any) =>
            conversations.get(input.externalConversationId) ?? null,
        ),
        listParticipantExternalUserIds: vi.fn(async () => ['admin']),
        listConversationApprovers: vi.fn(async (conversationId: string) => [
          {
            id: `approver:${conversationId}:admin`,
            appId: 'default',
            conversationId,
            externalUserId: 'admin',
            createdAt: iso,
            updatedAt: iso,
          },
        ]),
      },
    };
    const service = new ConversationAdministrationService(
      repositories as never,
    );

    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'telegram' as never,
        providerAccountId: 'provider-account-telegram' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'tg:-100123',
        userId: 'admin',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack' as never,
        providerAccountId: 'provider-account-slack' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'sl:C123',
        userId: 'admin',
      }),
    ).resolves.toBe(true);
  });

  it('looks up approver conversations within the provider account', async () => {
    const providerAccounts = new Map([
      [
        'slack-one',
        {
          id: 'slack-one',
          appId: 'default',
          agentId: 'agent:main',
          providerId: 'slack',
          label: 'Slack One',
          status: 'active',
          config: {},
          runtimeSecretRefs: {},
          createdAt: iso,
          updatedAt: iso,
        },
      ],
      [
        'slack-two',
        {
          id: 'slack-two',
          appId: 'default',
          agentId: 'agent:main',
          providerId: 'slack',
          label: 'Slack Two',
          status: 'active',
          config: {},
          runtimeSecretRefs: {},
          createdAt: iso,
          updatedAt: iso,
        },
      ],
    ]);
    const conversations = [
      {
        id: 'conversation:slack-one:sl:C123',
        appId: 'default',
        providerAccountId: 'slack-one',
        externalRef: { kind: 'conversation', value: 'sl:C123' },
        kind: 'channel',
        title: 'One',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      {
        id: 'conversation:slack-two:sl:C123',
        appId: 'default',
        providerAccountId: 'slack-two',
        externalRef: { kind: 'conversation', value: 'sl:C123' },
        kind: 'channel',
        title: 'Two',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
    ];
    const repositories = {
      providerAccounts: {
        getProviderAccount: vi.fn(async (id: string) =>
          providerAccounts.get(id),
        ),
        getConversationInstall: vi.fn(async (input: any) => ({
          id: `install:${input.agentId}:${input.conversationId}`,
          appId: input.appId,
          agentId: input.agentId,
          providerAccountId: 'slack-two',
          conversationId: input.conversationId,
          displayName: 'Two',
          status: 'active',
          senderPolicy: 'provider_native',
          controlPolicy: 'conversation_approvers',
          memoryScope: 'conversation',
          memorySubject: {
            appId: input.appId,
            agentId: input.agentId,
            subjectType: 'conversation',
            subjectId: input.conversationId,
          },
          permissionPolicyIds: [],
          createdAt: iso,
          updatedAt: iso,
        })),
      },
      conversations: {
        getConversation: vi.fn(async () => conversations[0]),
        getConversationByExternalRef: vi.fn(async (input: any) =>
          conversations.find(
            (conversation) =>
              conversation.providerAccountId === input.providerAccountId &&
              conversation.externalRef.value === input.externalConversationId,
          ),
        ),
        findConversationByExternalValue: vi.fn(async () => conversations[0]),
        listParticipantExternalUserIds: vi.fn(async () => ['U2']),
        listConversationApprovers: vi.fn(async (conversationId: string) =>
          conversationId === 'conversation:slack-two:sl:C123'
            ? [
                {
                  id: 'approver:U2',
                  appId: 'default',
                  conversationId,
                  externalUserId: 'U2',
                  createdAt: iso,
                  updatedAt: iso,
                },
              ]
            : [],
        ),
      },
    };
    const service = new ConversationAdministrationService(
      repositories as never,
    );

    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack' as never,
        providerAccountId: 'slack-two' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'sl:C123',
        userId: 'U2',
      }),
    ).resolves.toBe(true);
    expect(
      repositories.conversations.getConversationByExternalRef,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: 'slack-two' }),
    );
  });

  it('falls through disabled migrated direct conversations to the active scoped clone', async () => {
    const providerAccount = {
      id: 'provider-account-slack',
      appId: 'default',
      agentId: 'agent:main',
      providerId: 'slack',
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: iso,
      updatedAt: iso,
    };
    const legacyConversation = {
      id: 'conversation:sl:C123',
      appId: 'default',
      providerAccountId: 'provider-account-slack',
      externalRef: { kind: 'conversation', value: 'sl:C123' },
      kind: 'channel',
      title: 'Legacy',
      status: 'disabled',
      createdAt: iso,
      updatedAt: iso,
    };
    const scopedConversation = {
      ...legacyConversation,
      id: 'conversation:provider-account-slack:sl:C123',
      title: 'Scoped',
      status: 'active',
    };
    const repositories = {
      providerAccounts: {
        getProviderAccount: vi.fn(async () => providerAccount),
        getConversationInstall: vi.fn(async (input: any) =>
          input.conversationId === scopedConversation.id
            ? {
                id: `install:${input.agentId}:${input.conversationId}`,
                appId: input.appId,
                agentId: input.agentId,
                providerAccountId: providerAccount.id,
                conversationId: input.conversationId,
                displayName: 'Scoped',
                status: 'active',
                senderPolicy: 'provider_native',
                controlPolicy: 'conversation_approvers',
                memoryScope: 'conversation',
                memorySubject: {
                  appId: input.appId,
                  agentId: input.agentId,
                  subjectType: 'conversation',
                  subjectId: input.conversationId,
                },
                permissionPolicyIds: [],
                createdAt: iso,
                updatedAt: iso,
              }
            : null,
        ),
      },
      conversations: {
        getConversation: vi.fn(async (id: string) =>
          id === legacyConversation.id ? legacyConversation : null,
        ),
        getConversationByExternalRef: vi.fn(async (input: any) =>
          input.providerAccountId === providerAccount.id &&
          input.externalConversationId === 'sl:C123'
            ? scopedConversation
            : null,
        ),
        listParticipantExternalUserIds: vi.fn(async () => ['U2']),
        listConversationApprovers: vi.fn(async (conversationId: string) =>
          conversationId === scopedConversation.id
            ? [
                {
                  id: 'approver:U2',
                  appId: 'default',
                  conversationId,
                  externalUserId: 'U2',
                  createdAt: iso,
                  updatedAt: iso,
                },
              ]
            : [],
        ),
      },
    };
    const service = new ConversationAdministrationService(
      repositories as never,
    );

    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack' as never,
        providerAccountId: providerAccount.id as never,
        agentId: 'agent:main' as never,
        conversationJid: 'sl:C123',
        userId: 'U2',
      }),
    ).resolves.toBe(true);
  });

  it('uses the request thread when authorizing conversation approvers', async () => {
    const providerAccount = {
      id: 'slack-one',
      appId: 'default',
      agentId: 'agent:main',
      providerId: 'slack',
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: iso,
      updatedAt: iso,
    };
    const conversation = {
      id: 'conversation:slack-one:sl:C123',
      appId: 'default',
      providerAccountId: 'slack-one',
      externalRef: { kind: 'conversation', value: 'sl:C123' },
      kind: 'channel',
      title: 'Slack Channel',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    const getConversationInstall = vi.fn(async (input: any) =>
      input.threadId === 'thread:slack-one:sl:C123:171.222'
        ? {
            id: 'install:thread',
            appId: input.appId,
            agentId: input.agentId,
            providerAccountId: 'slack-one',
            conversationId: input.conversationId,
            threadId: input.threadId,
            displayName: 'Thread install',
            status: 'active',
            senderPolicy: 'provider_native',
            controlPolicy: 'conversation_approvers',
            memoryScope: 'conversation',
            memorySubject: {
              appId: input.appId,
              agentId: input.agentId,
              subjectType: 'conversation',
              subjectId: input.conversationId,
            },
            permissionPolicyIds: [],
            createdAt: iso,
            updatedAt: iso,
          }
        : null,
    );
    const service = new ConversationAdministrationService({
      providerAccounts: {
        getProviderAccount: vi.fn(async () => providerAccount),
        getConversationInstall,
      },
      conversations: {
        getConversation: vi.fn(async () => null),
        getConversationByExternalRef: vi.fn(async () => conversation),
        listParticipantExternalUserIds: vi.fn(async () => ['U2']),
        listConversationApprovers: vi.fn(async () => [
          {
            id: 'approver:U2',
            appId: 'default',
            conversationId: conversation.id,
            externalUserId: 'U2',
            createdAt: iso,
            updatedAt: iso,
          },
        ]),
      },
    } as never);

    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack' as never,
        providerAccountId: 'slack-one' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'sl:C123',
        threadId: '171.222',
        userId: 'U2',
      }),
    ).resolves.toBe(true);
    expect(getConversationInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread:slack-one:sl:C123:171.222',
      }),
    );
  });
});
