import { describe, expect, it, vi } from 'vitest';

import {
  ChannelAdministrationService,
  type ChannelMembershipValidator,
} from '@core/application/channels/channel-administration-service.js';

const iso = '2026-05-01T00:00:00.000Z';

function makeService(options?: {
  validUserIds?: string[];
  participantUserIds?: string[];
  providerId?: string;
}) {
  const installation = {
    id: 'installation-1',
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
    id: 'channel-1',
    appId: 'default',
    channelInstallationId: 'installation-1',
    externalRef: { kind: 'conversation', value: 'tg:-100123' },
    kind: 'group',
    title: 'Team',
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
  };
  const storedApprovers: string[] = [];
  const repositories = {
    channelInstallations: {
      getChannelInstallation: vi.fn(async () => installation),
      updateChannelInstallation: vi.fn(async (input: any) => ({
        ...installation,
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
      listChannelControlApprovers: vi.fn(async () =>
        storedApprovers.map((externalUserId) => ({
          id: `approver:${externalUserId}`,
          appId: 'default',
          conversationId: conversation.id,
          externalUserId,
          createdAt: iso,
          updatedAt: iso,
        })),
      ),
      replaceChannelControlApprovers: vi.fn(async (input: any) => {
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
  const validator: ChannelMembershipValidator | undefined =
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
    service: new ChannelAdministrationService(repositories as never, validator),
    repositories,
  };
}

describe('ChannelAdministrationService', () => {
  it('replaces channel control allowlist deterministically', async () => {
    const { service, repositories } = makeService({
      validUserIds: ['123', '456'],
    });

    const result = await service.replaceControlAllowlist({
      appId: 'default' as never,
      conversationId: 'channel-1' as never,
      userIds: ['456', '123', '123'],
      updatedAt: iso,
    });

    expect(result).toEqual({ userIds: ['123', '456'] });
    expect(
      repositories.conversations.replaceChannelControlApprovers,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserIds: ['123', '456'] }),
    );
  });

  it('rejects control approvers that are not channel members', async () => {
    const { service, repositories } = makeService({ validUserIds: ['123'] });

    await expect(
      service.replaceControlAllowlist({
        appId: 'default' as never,
        conversationId: 'channel-1' as never,
        userIds: ['123', '999'],
        updatedAt: iso,
      }),
    ).rejects.toThrow(/Control approvers must be members/);
    expect(
      repositories.conversations.replaceChannelControlApprovers,
    ).not.toHaveBeenCalled();
  });

  it('returns only channel-owned control approvers in admin summary', async () => {
    const { service } = makeService({ validUserIds: ['123'] });

    await service.replaceControlAllowlist({
      appId: 'default' as never,
      conversationId: 'channel-1' as never,
      userIds: ['123'],
      updatedAt: iso,
    });
    const summary = await service.getAdminSummary({
      appId: 'default' as never,
      conversationId: 'channel-1' as never,
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
        conversationId: 'channel-1' as never,
        userIds: ['member-1', 'outsider-1'],
        updatedAt: iso,
      }),
    ).rejects.toThrow(/Control approvers must be members/);
    expect(
      repositories.conversations.listParticipantExternalUserIds,
    ).toHaveBeenCalledWith('channel-1');
    expect(
      repositories.conversations.replaceChannelControlApprovers,
    ).not.toHaveBeenCalled();
  });
});
