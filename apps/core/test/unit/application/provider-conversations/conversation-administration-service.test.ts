import { describe, expect, it, vi } from 'vitest';

import { ConversationAdministrationService } from '@core/application/provider-conversations/conversation-administration-service.js';

const iso = '2026-08-09T00:00:00.000Z';

function makeService(input: {
  conversationKind: 'direct' | 'group';
  participantUserIds: string[];
  approverUserIds?: string[];
  resolvedApprover?: { personId: string; aliasId?: string } | null;
}) {
  const providerAccount = {
    id: 'provider-account-1',
    appId: 'default',
    agentId: 'agent:main',
    providerId: 'local',
    label: 'Local',
    status: 'active',
    config: {},
    runtimeSecretRefs: {},
    createdAt: iso,
    updatedAt: iso,
  };
  const conversation = {
    id: 'conversation:provider-account-1:chat-1',
    appId: 'default',
    providerAccountId: providerAccount.id,
    externalRef: { kind: 'conversation', value: 'chat-1' },
    kind: input.conversationKind,
    title: 'Conversation',
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
  };
  const listConversationApprovers = vi.fn(async () =>
    (input.approverUserIds ?? []).map((externalUserId) => ({
      id: `approver:${externalUserId}`,
      appId: 'default',
      conversationId: conversation.id,
      externalUserId,
      createdAt: iso,
      updatedAt: iso,
    })),
  );
  const repositories = {
    providerAccounts: {
      getConversationInstall: vi.fn(async () => ({
        status: 'active',
      })),
      getProviderAccount: vi.fn(async () => providerAccount),
    },
    conversations: {
      getConversation: vi.fn(async () => null),
      getConversationByExternalRef: vi.fn(async () => conversation),
      listParticipantExternalUserIds: vi.fn(
        async () => input.participantUserIds,
      ),
      listConversationApprovers,
      resolveConversationApproverPrincipal: vi.fn(
        async () => input.resolvedApprover ?? null,
      ),
    },
  };

  return {
    service: new ConversationAdministrationService(repositories as never),
    listConversationApprovers,
  };
}

describe('isControlApproverAllowed', () => {
  it('DM participant authorized without an allowlist entry; non-participant denied', async () => {
    const { service, listConversationApprovers } = makeService({
      conversationKind: 'direct',
      participantUserIds: ['dm-user'],
    });

    const request = {
      appId: 'default' as never,
      providerId: 'local' as never,
      providerAccountId: 'provider-account-1' as never,
      agentId: 'agent:main' as never,
      conversationJid: 'chat-1',
    };
    await expect(
      service.isControlApproverAllowed({ ...request, userId: 'dm-user' }),
    ).resolves.toBe(true);
    await expect(
      service.isControlApproverAllowed({ ...request, userId: 'outsider' }),
    ).resolves.toBe(false);
    expect(listConversationApprovers).not.toHaveBeenCalled();
  });

  it('group still requires an allowlisted approver', async () => {
    const { service } = makeService({
      conversationKind: 'group',
      participantUserIds: ['allowlisted-user', 'member-only'],
      approverUserIds: ['allowlisted-user'],
    });

    const request = {
      appId: 'default' as never,
      providerId: 'local' as never,
      providerAccountId: 'provider-account-1' as never,
      agentId: 'agent:main' as never,
      conversationJid: 'chat-1',
    };
    await expect(
      service.isControlApproverAllowed({
        ...request,
        userId: 'allowlisted-user',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isControlApproverAllowed({ ...request, userId: 'member-only' }),
    ).resolves.toBe(false);
  });

  it('allows a Teams approver when the inbound jid has the teams: prefix but the channel was discovered without it', async () => {
    const channelId = '19:abc@thread.tacv2';
    const conversation = {
      id: `conversation:provider-account-1:${channelId}`,
      appId: 'default',
      providerAccountId: 'provider-account-1',
      externalRef: { kind: 'conversation', value: channelId },
      kind: 'channel',
      title: 'Engineering',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    const getConversationByExternalRef = vi.fn(
      async (input: { externalConversationId: string }) =>
        input.externalConversationId === channelId ? conversation : null,
    );
    const validateControlApprovers = vi.fn(async (input: any) => ({
      validUserIds: input.userIds,
      invalidUserIds: [],
    }));
    const service = new ConversationAdministrationService(
      {
        providerAccounts: {
          getConversationInstall: vi.fn(async () => ({ status: 'active' })),
          getProviderAccount: vi.fn(async () => ({
            id: 'provider-account-1',
            providerId: 'teams',
          })),
        },
        conversations: {
          getConversation: vi.fn(async () => null),
          getConversationByExternalRef,
          listConversationApprovers: vi.fn(async () => [
            { externalUserId: 'aad-user-1' },
          ]),
        },
      } as never,
      { validateControlApprovers } as never,
    );

    await expect(
      service.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'teams' as never,
        providerAccountId: 'provider-account-1' as never,
        agentId: 'agent:main' as never,
        conversationJid: `teams:${channelId}`,
        userId: 'aad-user-1',
      }),
    ).resolves.toBe(true);
    expect(validateControlApprovers).toHaveBeenCalledWith(
      expect.objectContaining({ conversation }),
    );
  });

  it('resolves an authorized approver to its human principal', async () => {
    const { service } = makeService({
      conversationKind: 'group',
      participantUserIds: ['allowlisted-user'],
      approverUserIds: ['allowlisted-user'],
      resolvedApprover: { personId: 'person:approver', aliasId: 'alias:1' },
    });

    await expect(
      service.resolveControlApproverPrincipal({
        appId: 'default' as never,
        providerId: 'local' as never,
        providerAccountId: 'provider-account-1' as never,
        agentId: 'agent:main' as never,
        conversationJid: 'chat-1',
        userId: 'allowlisted-user',
      }),
    ).resolves.toEqual({
      kind: 'human',
      personId: 'person:approver',
      aliasId: 'alias:1',
    });
  });
});
