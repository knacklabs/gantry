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
  const providerConnection = {
    id: 'providerConnection-1',
    appId: 'default',
    providerId: options?.providerId ?? 'telegram',
    label: 'Telegram',
    status: 'active',
    config: {},
    runtimeSecretRefs: ['TELEGRAM_BOT_TOKEN'],
    createdAt: iso,
    updatedAt: iso,
  };
  const conversation = {
    id: 'conversation-1',
    appId: 'default',
    providerConnectionId: 'providerConnection-1',
    externalRef: { kind: 'conversation', value: 'tg:-100123' },
    kind: options?.conversationKind ?? 'group',
    title: 'Team',
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
  };
  const storedApprovers: string[] = [];
  const repositories = {
    providerConnections: {
      getProviderConnection: vi.fn(async () => providerConnection),
      updateProviderConnection: vi.fn(async (input: any) => ({
        ...providerConnection,
        config: input.patch.config,
      })),
    },
    conversations: {
      getConversation: vi.fn(async (id: string) =>
        id === conversation.id ? conversation : null,
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

  it('rejects control allowlist updates for direct conversations', async () => {
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
    ).rejects.toThrow(/direct/i);
    expect(
      repositories.conversations.replaceConversationApprovers,
    ).not.toHaveBeenCalled();
  });

  it('keeps approvers scoped to the origin conversation provider', async () => {
    const providerConnections = new Map([
      [
        'providerConnection-slack',
        {
          id: 'providerConnection-slack',
          appId: 'default',
          providerId: 'slack',
          label: 'Slack',
          status: 'active',
          config: {},
          runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
          createdAt: iso,
          updatedAt: iso,
        },
      ],
      [
        'providerConnection-teams',
        {
          id: 'providerConnection-teams',
          appId: 'default',
          providerId: 'teams',
          label: 'Teams',
          status: 'active',
          config: {},
          runtimeSecretRefs: ['TEAMS_CLIENT_ID'],
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
          providerConnectionId: 'providerConnection-slack',
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
          providerConnectionId: 'providerConnection-teams',
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
      providerConnections: {
        getProviderConnection: vi.fn(async (id: string) =>
          providerConnections.get(id),
        ),
      },
      conversations: {
        getConversation: vi.fn(async (id: string) => conversations.get(id)),
        findConversationByExternalValue: vi.fn(async (input: any) =>
          [...conversations.values()].find(
            (conversation) =>
              conversation.externalRef.value === input.externalConversationId,
          ),
        ),
        listParticipantExternalUserIds: vi.fn(async () => []),
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
        conversationJid: 'slack:C123',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'teams' as never,
        conversationJid: 'teams:19:channel@thread.tacv2',
        userId: '8:orgid:admin',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'teams' as never,
        conversationJid: 'teams:19:channel@thread.tacv2',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(false);
    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack' as never,
        conversationJid: 'slack:C123',
        userId: '8:orgid:admin',
      }),
    ).resolves.toBe(false);
  });
});
