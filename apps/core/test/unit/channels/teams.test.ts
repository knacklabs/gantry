import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getProvider,
  providerForJid,
} from '@core/channels/provider-registry.js';
import '@core/channels/register-builtins.js';
import { TEAMS_HARD_MESSAGE_BYTES } from '@core/channels/teams-delivery.js';
import {
  TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  TeamsChannel,
  type TeamsSdkClient,
  type TeamsInboundMessage,
  buildTeamsApprovalDescriptorPayload,
  createTeamsChannel,
  normalizeTeamsJid,
  teamsConversationIdFromJid,
} from '@core/channels/teams.js';
import {
  sendTeamsProgressUpdate,
  type TeamsProgressMessages,
} from '@core/channels/teams-progress.js';
import { formatTeamsAttachmentUnavailableCopy } from '@core/channels/teams-cards.js';
import type { ChannelOpts } from '@core/channels/channel-provider.js';
import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  configurePendingInteractionDurability(null);
  vi.useRealTimers();
});

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(async () => {}),
    onChatMetadata: vi.fn(async () => {}),
    conversationRoutes: vi.fn(() => ({})),
    runtimeSecrets: {
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`Missing ${ref.env}`);
        return value;
      },
      getOptionalSecret(ref) {
        return {
          TEAMS_CLIENT_ID: 'client-id',
          TEAMS_CLIENT_SECRET: 'client-secret',
          TEAMS_TENANT_ID: 'tenant-id',
        }[ref.env];
      },
    },
  };
}

type TeamsSdkClientWithRoot = TeamsSdkClient & {
  getChannelMessage(input: {
    conversationId: string;
    messageId: string;
  }): Promise<TeamsInboundMessage>;
};

describe('Teams built-in provider', () => {
  it('uses the locked no-link copy for unavailable attachments', () => {
    expect(
      formatTeamsAttachmentUnavailableCopy(
        'Ship the note.\n\nAttachments:\n- Attachment unavailable.',
      ),
    ).toBe(
      'Ship the note.\n\nAttachments:\n- Attachment unavailable in Teams until signed artifact links are added.',
    );
    expect(
      formatTeamsAttachmentUnavailableCopy(
        'Ship the note.\n\nAttachments:\n- daily.md (text/markdown, 1024 bytes)',
        true,
      ),
    ).toBe(
      'Ship the note.\n\nAttachments:\n- Attachment unavailable in Teams until signed artifact links are added.',
    );
  });

  it('registers Teams provider metadata and ownership prefix', () => {
    const provider = getProvider('teams');

    expect(provider).toEqual(
      expect.objectContaining({
        id: 'teams',
        label: 'Teams',
        jidPrefix: 'teams:',
        folderPrefix: 'teams_',
        formatting: 'markdown-native',
      }),
    );
    expect(provider?.setup.envKeys).toEqual([
      'TEAMS_CLIENT_ID',
      'TEAMS_CLIENT_SECRET',
      'TEAMS_TENANT_ID',
    ]);
    expect(providerForJid('teams:19:abc@thread.v2')?.id).toBe('teams');
  });
});

describe('Teams JID helpers', () => {
  it('normalizes Teams conversation ids into canonical Teams JIDs', () => {
    expect(normalizeTeamsJid('19:abc@thread.v2')).toBe(
      'teams:19:abc@thread.v2',
    );
    expect(normalizeTeamsJid(' teams:19:abc@thread.v2 ')).toBe(
      'teams:19:abc@thread.v2',
    );
    expect(normalizeTeamsJid('')).toBeNull();
    expect(teamsConversationIdFromJid('teams:19:abc@thread.v2')).toBe(
      '19:abc@thread.v2',
    );
    expect(teamsConversationIdFromJid('sl:C123')).toBeNull();
  });
});

describe('Teams Adaptive Card payloads', () => {
  it('builds Action.Execute allow-once and cancel actions', () => {
    const payload = buildTeamsApprovalDescriptorPayload({
      requestId: 'perm-1',
      sourceAgentFolder: 'teams_main',
      targetJid: 'teams:19:abc@thread.v2',
      threadId: 'root-message',
      toolName: 'Bash',
      toolInput: {
        command: 'git status --short',
      },
    });

    expect(payload.attachments[0].contentType).toBe(
      TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
    );
    expect(payload.attachments[0].content.actions).toEqual([
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Allow once',
        verb: 'gantry.permission.allow',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'allow_once',
        }),
      }),
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Allow 5 min',
        verb: 'gantry.permission.allow',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'allow_timed_grant',
        }),
      }),
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Cancel',
        verb: 'gantry.permission.cancel',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'cancel',
        }),
      }),
    ]);
    expect(JSON.stringify(payload)).toContain('git status --short');
  });

  it('keeps Teams on the inline approval fallback until task-module transport exists', () => {
    const payload = buildTeamsApprovalDescriptorPayload({
      requestId: 'perm-1',
      sourceAgentFolder: 'teams_main',
      targetJid: 'teams:19:abc@thread.v2',
      toolName: 'Bash',
      toolInput: {
        command: 'npm test -- --runInBand',
      },
    });

    const rendered = JSON.stringify(payload);
    expect(rendered).toContain('npm test -- --runInBand');
    expect(rendered).not.toContain('View full command');
    expect(rendered).not.toContain('task/fetch');
  });
});

describe('TeamsChannel adapter scaffold', () => {
  it('does not post visible Teams reaction text', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect({ inbound: false });

    await channel.addReaction('teams:19:abc@thread.v2', 'message-1', 'running');
    await channel.addReaction('teams:19:abc@thread.v2', 'message-1', 'running');

    expect(sdkClient.sendMessage).not.toHaveBeenCalled();
  });

  it('renders todo cards in the active Teams thread', async () => {
    let messageCounter = 0;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: `todo-${++messageCounter}`,
      })),
      updateAdaptiveCard: vi.fn(async () => ({})),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect({ inbound: false });

    await channel.renderAgentTodo('teams:19:abc@thread.v2', {
      threadId: 'reply-a',
      headline: 'Searching the web',
      status: 'running',
      elapsed: '2m 14s',
      stop: { label: 'Stop', actionToken: 'stop-token-1' },
      items: [{ id: '1', title: 'First', status: 'pending' }],
    });
    await channel.renderAgentTodo('teams:19:abc@thread.v2', {
      threadId: 'reply-b',
      items: [{ id: '2', title: 'Second', status: 'pending' }],
    });
    await channel.renderAgentTodo('teams:19:abc@thread.v2', {
      threadId: 'reply-a',
      status: 'done',
      stop: { label: 'Stop', actionToken: 'stale-stop-token' },
      items: [{ id: '1', title: 'First', status: 'completed' }],
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ threadId: 'reply-a' }),
    );
    const firstCard = vi.mocked(sdkClient.sendAdaptiveCard).mock.calls[0]?.[0]
      ?.card as any;
    expect(JSON.stringify(firstCard)).toContain(
      '⏳ Searching the web · 2m 14s',
    );
    expect(JSON.stringify(firstCard.actions)).toContain('stop-token-1');
    expect(JSON.stringify(firstCard.actions)).toContain(
      'teams:19:abc@thread.v2',
    );
    expect(sdkClient.sendAdaptiveCard).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threadId: 'reply-b' }),
    );
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'todo-1',
        threadId: 'reply-a',
        card: expect.objectContaining({ actions: [] }),
      }),
    );
  });

  it('normalizes inbound Teams SDK messages and sends outbound through the seam', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
    };
    const opts = makeOpts();
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );

    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(sdkClient.start).toHaveBeenCalledWith({
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      onMessage: expect.any(Function),
    });

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      id: 'activity-1',
      text: 'hello from Teams',
      from: {
        id: 'user-1',
        name: 'Ravi',
      },
      timestamp: '2026-04-30T00:00:00.000Z',
      threadId: 'root-message',
      conversationName: 'Engineering',
      conversationType: 'channel',
    });

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'teams:19:abc@thread.v2',
      '2026-04-30T00:00:00.000Z',
      'Engineering',
      'teams',
      true,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'teams:19:abc@thread.v2',
      expect.objectContaining({
        id: 'activity-1',
        chat_jid: 'teams:19:abc@thread.v2',
        provider: 'teams',
        sender: 'user-1',
        sender_name: 'Ravi',
        content: 'hello from Teams',
        thread_id: 'root-message',
      }),
    );

    await expect(
      channel.sendMessage('teams:19:abc@thread.v2', 'response', {
        threadId: 'root-message',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ externalMessageId: 'teams-msg-1' }),
    );
    expect(sdkClient.sendMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      text: 'response',
      threadId: 'root-message',
    });

    await channel.disconnect();

    expect(channel.isConnected()).toBe(false);
    expect(sdkClient.stop).toHaveBeenCalled();
  });

  it('ingests attachment-only Teams messages with provider metadata only', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
    };
    const opts = makeOpts();
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );

    await channel.connect();
    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      id: 'activity-attachment',
      text: '   ',
      from: {
        id: 'user-1',
        name: 'Ravi',
      },
      timestamp: '2026-04-30T00:00:00.000Z',
      attachments: [
        {
          id: 'teams-image',
          contentType: 'image/png',
          sizeBytes: 4096,
        },
      ],
    });
    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      id: 'activity-empty',
      text: '   ',
      from: {
        id: 'user-1',
        name: 'Ravi',
      },
      timestamp: '2026-04-30T00:00:01.000Z',
    });

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    expect(opts.onMessage).toHaveBeenCalledWith(
      'teams:19:abc@thread.v2',
      expect.objectContaining({
        id: 'activity-attachment',
        chat_jid: 'teams:19:abc@thread.v2',
        provider: 'teams',
        content: '',
        attachments: [
          {
            id: 'teams-attachment:teams-image',
            kind: 'image',
            contentType: 'image/png',
            sizeBytes: 4096,
            externalId: 'teams-image',
          },
        ],
      }),
    );
  });

  it('skips Teams context hydration when the SDK has no history methods', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );

    await expect(
      channel.hydrateConversationContext({
        conversationJid: 'teams:19:abc@thread.v2',
        latestMessage: {
          id: 'current',
          timestamp: '2026-04-30T00:00:00.000Z',
          external_message_id: 'activity-3',
        },
        limits: { channelMessages: 30, threadMessages: 50 },
      }),
    ).resolves.toMatchObject({
      providerId: 'teams',
      attempted: false,
      skipped: true,
      reason: 'unsupported_sdk',
      messages: [],
    });
  });

  it('hydrates Teams attachment-only context messages with provider metadata only', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
      listChannelMessages: vi.fn(async () => [
        {
          conversationId: '19:abc@thread.v2',
          id: 'activity-1',
          text: '',
          from: { id: 'user-1', name: 'Ravi' },
          timestamp: '2026-04-30T00:00:01.000Z',
          attachments: [
            {
              id: 'teams-image',
              contentType: 'image/png',
              sizeBytes: 4096,
            },
          ],
        },
        {
          conversationId: '19:abc@thread.v2',
          id: 'activity-2',
          text: 'report attached',
          senderId: 'user-2',
          senderName: 'Maya',
          timestamp: '2026-04-30T00:00:02.000Z',
          attachments: [
            {
              id: 'teams-file',
              contentType: 'application/pdf',
              sizeBytes: 8192,
            },
          ],
        },
        {
          conversationId: '19:abc@thread.v2',
          id: 'activity-3',
          text: '',
          from: { id: 'user-3', name: 'Isha' },
          timestamp: '2026-04-30T00:00:03.000Z',
        },
      ]),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );

    const result = await channel.hydrateConversationContext({
      conversationJid: 'teams:19:abc@thread.v2',
      latestMessage: {
        id: 'current',
        timestamp: '2026-04-30T00:00:04.000Z',
        external_message_id: 'activity-4',
      },
      limits: { channelMessages: 3, threadMessages: 50 },
    });

    expect(sdkClient.listChannelMessages).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      beforeMessageId: 'activity-4',
      limit: 3,
    });
    expect(result.messages).toEqual([
      expect.objectContaining({
        external_message_id: 'activity-1',
        content: '',
        is_from_me: false,
        is_bot_message: false,
        attachments: [
          expect.objectContaining({
            kind: 'image',
            contentType: 'image/png',
            sizeBytes: 4096,
            externalId: 'teams-image',
          }),
        ],
      }),
      expect.objectContaining({
        external_message_id: 'activity-2',
        content: 'report attached',
        is_from_me: false,
        is_bot_message: false,
        attachments: [
          expect.objectContaining({
            kind: 'file',
            contentType: 'application/pdf',
            sizeBytes: 8192,
            externalId: 'teams-file',
          }),
        ],
      }),
    ]);
  });

  it('only marks configured Teams self bot history as bot messages', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
      listChannelMessages: vi.fn(async () => [
        {
          conversationId: '19:abc@thread.v2',
          id: 'activity-1',
          text: 'deploy finished',
          from: { id: '28:other-bot-id', name: 'BuildBot' },
          timestamp: '2026-04-30T00:00:01.000Z',
        },
        {
          conversationId: '19:abc@thread.v2',
          id: 'activity-2',
          text: 'Gantry summary',
          from: { id: '28:client-id', name: 'Gantry' },
          timestamp: '2026-04-30T00:00:02.000Z',
        },
        {
          conversationId: '19:abc@thread.v2',
          id: 'activity-3',
          text: 'looks good',
          from: { id: 'user-1', name: 'Ravi' },
          timestamp: '2026-04-30T00:00:03.000Z',
        },
      ]),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );

    const result = await channel.hydrateConversationContext({
      conversationJid: 'teams:19:abc@thread.v2',
      latestMessage: {
        id: 'current',
        timestamp: '2026-04-30T00:00:04.000Z',
        external_message_id: 'activity-4',
      },
      limits: { channelMessages: 3, threadMessages: 50 },
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        sender: '28:other-bot-id',
        content: 'deploy finished',
        is_from_me: false,
        is_bot_message: false,
      }),
      expect.objectContaining({
        sender: '28:client-id',
        content: 'Gantry summary',
        is_from_me: true,
        is_bot_message: true,
        delivery_status: 'sent',
      }),
      expect.objectContaining({
        sender: 'user-1',
        content: 'looks good',
        is_from_me: false,
        is_bot_message: false,
      }),
    ]);
  });

  it('hydrates Teams reply chains through the optional SDK method', async () => {
    const sdkClient: TeamsSdkClientWithRoot = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
      getChannelMessage: vi.fn(async () => ({
        conversationId: '19:abc@thread.v2',
        id: 'root-message',
        text: 'thread root',
        from: { id: 'user-root', name: 'Root User' },
        timestamp: '2026-04-30T00:00:00.000Z',
      })),
      listChannelMessageReplies: vi.fn(async () => [
        {
          conversationId: '19:abc@thread.v2',
          id: 'reply-1',
          text: 'first reply',
          from: { id: 'user-1', name: 'Ravi' },
          timestamp: '2026-04-30T00:00:01.000Z',
        },
        {
          conversationId: '19:abc@thread.v2',
          id: 'reply-2',
          text: 'second reply',
          senderId: '28:client-id',
          senderName: 'Gantry',
          timestamp: '2026-04-30T00:00:02.000Z',
          replyToId: 'root-message',
        },
        {
          conversationId: '19:abc@thread.v2',
          id: 'reply-3',
          text: 'third reply',
          senderId: 'user-2',
          senderName: 'Maya',
          timestamp: '2026-04-30T00:00:03.000Z',
          replyToId: 'root-message',
        },
      ]),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );

    const result = await channel.hydrateConversationContext({
      conversationJid: 'teams:19:abc@thread.v2',
      threadId: 'root-message',
      latestMessage: {
        id: 'current',
        timestamp: '2026-04-30T00:00:04.000Z',
        external_message_id: 'reply-4',
        thread_id: 'root-message',
      },
      limits: { channelMessages: 30, threadMessages: 3 },
    });

    expect(sdkClient.getChannelMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      messageId: 'root-message',
    });
    expect(sdkClient.listChannelMessageReplies).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      messageId: 'root-message',
      beforeMessageId: 'reply-4',
      limit: 2,
    });
    expect(result.messages).toEqual([
      expect.objectContaining({
        external_message_id: 'root-message',
        thread_id: 'root-message',
        reply_to_message_id: undefined,
        content: 'thread root',
        is_from_me: false,
        is_bot_message: false,
      }),
      expect.objectContaining({
        external_message_id: 'reply-1',
        thread_id: 'root-message',
        reply_to_message_id: 'root-message',
        is_from_me: false,
        is_bot_message: false,
      }),
      expect.objectContaining({
        external_message_id: 'reply-2',
        thread_id: 'root-message',
        reply_to_message_id: 'root-message',
        is_from_me: true,
        is_bot_message: true,
        sender_name: 'Gantry',
      }),
    ]);
  });

  it('hydrates Teams reply chains through replies when the root SDK method is absent', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
      listChannelMessageReplies: vi.fn(async () => [
        {
          conversationId: '19:abc@thread.v2',
          id: 'reply-1',
          text: 'first reply',
          from: { id: 'user-1', name: 'Ravi' },
          timestamp: '2026-04-30T00:00:01.000Z',
          replyToId: 'root-message',
        },
        {
          conversationId: '19:abc@thread.v2',
          id: 'reply-2',
          text: 'second reply',
          senderId: '28:client-id',
          senderName: 'Gantry',
          timestamp: '2026-04-30T00:00:02.000Z',
          replyToId: 'root-message',
        },
      ]),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );

    const result = await channel.hydrateConversationContext({
      conversationJid: 'teams:19:abc@thread.v2',
      threadId: 'root-message',
      latestMessage: {
        id: 'current',
        timestamp: '2026-04-30T00:00:04.000Z',
        external_message_id: 'reply-4',
        thread_id: 'root-message',
      },
      limits: { channelMessages: 30, threadMessages: 3 },
    });

    expect(sdkClient.listChannelMessageReplies).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      messageId: 'root-message',
      beforeMessageId: 'reply-4',
      limit: 3,
    });
    expect(result.messages).toEqual([
      expect.objectContaining({
        external_message_id: 'reply-1',
        thread_id: 'root-message',
        reply_to_message_id: 'root-message',
        is_from_me: false,
        is_bot_message: false,
      }),
      expect.objectContaining({
        external_message_id: 'reply-2',
        thread_id: 'root-message',
        reply_to_message_id: 'root-message',
        is_from_me: true,
        is_bot_message: true,
        sender_name: 'Gantry',
      }),
    ]);
  });

  it('hydrates Teams reply chains when the thread root fetch fails', async () => {
    const sdkClient: TeamsSdkClientWithRoot = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
      getChannelMessage: vi.fn(async () => {
        throw new Error('root unavailable');
      }),
      listChannelMessageReplies: vi.fn(async () => [
        {
          conversationId: '19:abc@thread.v2',
          id: 'reply-1',
          text: 'first reply',
          from: { id: 'user-1', name: 'Ravi' },
          timestamp: '2026-04-30T00:00:01.000Z',
        },
      ]),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );

    const result = await channel.hydrateConversationContext({
      conversationJid: 'teams:19:abc@thread.v2',
      threadId: 'root-message',
      latestMessage: {
        id: 'current',
        timestamp: '2026-04-30T00:00:04.000Z',
        external_message_id: 'reply-4',
        thread_id: 'root-message',
      },
      limits: { channelMessages: 30, threadMessages: 3 },
    });

    expect(sdkClient.listChannelMessageReplies).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      messageId: 'root-message',
      beforeMessageId: 'reply-4',
      limit: 3,
    });
    expect(result.messages).toEqual([
      expect.objectContaining({
        external_message_id: 'reply-1',
        thread_id: 'root-message',
        reply_to_message_id: 'root-message',
      }),
    ]);
  });

  it('routes Teams live stop card actions through the neutral message action callback', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const onMessageAction = vi.fn(async () => {});
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-stop-card',
      })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      { ...makeOpts(), onMessageAction },
      sdkClient,
    );
    await channel.connect();

    await channel.sendMessage('teams:19:abc@thread.v2', 'Running...', {
      threadId: 'root-message',
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'token-1',
        },
      ],
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        threadId: 'root-message',
        card: expect.objectContaining({
          actions: [
            expect.objectContaining({
              type: 'Action.Execute',
              verb: 'gantry.live.stop',
              data: expect.objectContaining({
                action: 'message_action',
                kind: 'live_turn_stop',
                actionToken: 'token-1',
                targetJid: 'teams:19:abc@thread.v2',
                threadId: 'root-message',
              }),
            }),
          ],
        }),
      }),
    );

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        data: {
          action: 'message_action',
          kind: 'live_turn_stop',
          actionToken: 'token-1',
          targetJid: 'teams:19:abc@thread.v2',
          threadId: 'root-message',
        },
      },
    });

    expect(onMessageAction).toHaveBeenCalledWith({
      kind: 'live_turn_stop',
      conversationJid: 'teams:19:abc@thread.v2',
      threadId: 'root-message',
      userId: 'teams-user-1',
      actionToken: 'token-1',
    });
  });

  it('routes Teams scheduler retry card actions through the neutral message action callback', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const onMessageAction = vi.fn(async () => {});
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-retry-card',
      })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      { ...makeOpts(), onMessageAction },
      sdkClient,
    );
    await channel.connect();

    await channel.sendMessage(
      'teams:19:abc@thread.v2',
      'Paused after failures',
      {
        threadId: 'root-message',
        actionAffordances: [
          { kind: 'scheduler_run_now', label: 'Retry now', jobId: 'job-1' },
          { kind: 'scheduler_pause_job', label: 'Pause job', jobId: 'job-1' },
          {
            kind: 'scheduler_open',
            label: 'Open in scheduler',
            jobId: 'job-1',
          },
        ],
      },
    );

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        threadId: 'root-message',
        card: expect.objectContaining({
          actions: [
            expect.objectContaining({
              type: 'Action.Execute',
              verb: 'gantry.scheduler.run_now',
              data: expect.objectContaining({
                action: 'message_action',
                kind: 'scheduler_run_now',
                jobId: 'job-1',
                targetJid: 'teams:19:abc@thread.v2',
                threadId: 'root-message',
              }),
            }),
          ],
        }),
      }),
    );

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        data: {
          action: 'message_action',
          kind: 'scheduler_run_now',
          jobId: 'job-1',
          targetJid: 'teams:19:abc@thread.v2',
          threadId: 'root-message',
        },
      },
    });

    expect(onMessageAction).toHaveBeenCalledWith({
      kind: 'scheduler_run_now',
      conversationJid: 'teams:19:abc@thread.v2',
      threadId: 'root-message',
      userId: 'teams-user-1',
      jobId: 'job-1',
    });
  });

  it('updates Teams progress cards and clears stop actions when done', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'progress-card-1',
      })),
      updateAdaptiveCard: vi.fn(async () => ({})),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    await channel.sendProgressUpdate('teams:19:abc@thread.v2', 'Working...', {
      threadId: 'root-message',
      generation: 7,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'token-7',
        },
      ],
    });
    await channel.sendProgressUpdate('teams:19:abc@thread.v2', 'Done.', {
      threadId: 'root-message',
      generation: 7,
      done: true,
      replaceOnly: true,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'token-7',
        },
      ],
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        messageId: 'progress-card-1',
        threadId: 'root-message',
        card: expect.objectContaining({
          body: [expect.objectContaining({ text: 'Done.' })],
          actions: [],
        }),
      }),
    );
  });

  it('sends action-only Teams progress cards with Stop action and no status body', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'progress-card-1',
      })),
      updateAdaptiveCard: vi.fn(async () => ({})),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    await channel.sendProgressUpdate('teams:19:abc@thread.v2', '', {
      actionOnly: true,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'token-7',
        },
      ],
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        card: expect.objectContaining({
          body: [],
          actions: [
            expect.objectContaining({
              title: 'Stop',
              data: expect.objectContaining({
                kind: 'live_turn_stop',
                actionToken: 'token-7',
              }),
            }),
          ],
        }),
      }),
    );
  });

  it('settles the Teams Stop progress card across generation rollover', async () => {
    const pendingProgress: TeamsProgressMessages = new Map();
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'progress-card-1',
      })),
      updateAdaptiveCard: vi.fn(async () => ({})),
    };

    await sendTeamsProgressUpdate({
      sdkClient,
      pendingProgress,
      jid: 'teams:19:abc@thread.v2',
      text: '',
      options: {
        threadId: 'root-message',
        generation: 1,
        actionOnly: true,
        actionAffordances: [
          {
            kind: 'live_turn_stop',
            label: 'Stop',
            actionToken: 'token-1',
          },
        ],
      },
    });
    await sendTeamsProgressUpdate({
      sdkClient,
      pendingProgress,
      jid: 'teams:19:abc@thread.v2',
      text: 'Done.',
      options: {
        threadId: 'root-message',
        generation: 2,
        done: true,
      },
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        messageId: 'progress-card-1',
        threadId: 'root-message',
        card: expect.objectContaining({
          body: [expect.objectContaining({ text: 'Done.' })],
          actions: [],
        }),
      }),
    );
    expect(pendingProgress.size).toBe(0);
  });

  it('streams Teams output by updating one native card at the Teams cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'stream-card-1',
      })),
      updateAdaptiveCard: vi.fn(async () => ({})),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    await channel.sendStreamingChunk('teams:19:abc@thread.v2', 'Hello', {
      threadId: 'root-message',
      generation: 1,
    });
    await channel.sendStreamingChunk('teams:19:abc@thread.v2', ' world', {
      threadId: 'root-message',
      generation: 1,
    });
    expect(sdkClient.updateAdaptiveCard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1800);
    await channel.sendStreamingChunk('teams:19:abc@thread.v2', '!', {
      threadId: 'root-message',
      generation: 1,
      done: true,
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        threadId: 'root-message',
        streamType: 'informative',
        card: expect.objectContaining({
          body: [expect.objectContaining({ text: 'Hello' })],
        }),
      }),
    );
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        messageId: 'stream-card-1',
        threadId: 'root-message',
        streamType: 'streaming',
        card: expect.objectContaining({
          body: [expect.objectContaining({ text: 'Hello world!' })],
        }),
      }),
    );
    expect(sdkClient.sendMessage).not.toHaveBeenCalled();
  });

  it('serializes Teams streaming updates for the same stream', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveFirstUpdate: ((value?: unknown) => void) | undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'stream-card-1',
      })),
      updateAdaptiveCard: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstUpdate = resolve;
            }),
        )
        .mockResolvedValue({}),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();
    await channel.sendStreamingChunk('teams:19:abc@thread.v2', 'A');
    await vi.advanceTimersByTimeAsync(1800);

    const firstUpdate = channel.sendStreamingChunk(
      'teams:19:abc@thread.v2',
      'B',
    );
    await Promise.resolve();
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledTimes(1);

    const secondUpdate = channel.sendStreamingChunk(
      'teams:19:abc@thread.v2',
      'C',
      { done: true },
    );
    await Promise.resolve();
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledTimes(1);

    resolveFirstUpdate?.({});
    await firstUpdate;
    await secondUpdate;

    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledTimes(2);
    expect(sdkClient.updateAdaptiveCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        card: expect.objectContaining({
          body: [expect.objectContaining({ text: 'ABC' })],
        }),
      }),
    );
  });

  it('splits Teams streaming output to a new message only at the hard cap', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async ({ text }) => ({
        externalMessageId: `overflow-${text.length}`,
      })),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'stream-card-1',
      })),
      updateAdaptiveCard: vi.fn(async () => ({})),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    await channel.sendStreamingChunk(
      'teams:19:abc@thread.v2',
      'x'.repeat(TEAMS_HARD_MESSAGE_BYTES - 1),
    );
    expect(sdkClient.sendMessage).not.toHaveBeenCalled();

    await channel.sendStreamingChunk('teams:19:abc@thread.v2', 'yy', {
      done: true,
    });

    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        card: expect.objectContaining({
          body: [
            expect.objectContaining({
              text: `${'x'.repeat(TEAMS_HARD_MESSAGE_BYTES - 1)}y`,
            }),
          ],
        }),
      }),
    );
    expect(sdkClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(sdkClient.sendMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      text: 'y',
    });
  });

  it('starts the SDK for outbound messages without processing inbound activities in outbound-only mode', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ externalMessageId: 'teams-msg-1' })),
    };
    const opts = makeOpts();
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );

    await channel.connect({ inbound: false });

    expect(channel.isConnected()).toBe(true);
    expect(sdkClient.start).toHaveBeenCalledWith({
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      onMessage: expect.any(Function),
    });
    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      id: 'ignored-activity',
      text: 'ignored',
      from: { id: 'user-1', name: 'Ravi' },
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
    await expect(
      channel.sendMessage('teams:19:abc@thread.v2', 'scheduler done'),
    ).resolves.toEqual(
      expect.objectContaining({ externalMessageId: 'teams-msg-1' }),
    );
    expect(sdkClient.sendMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      text: 'scheduler done',
    });

    await channel.disconnect();

    expect(channel.isConnected()).toBe(false);
    expect(sdkClient.stop).toHaveBeenCalled();
  });

  it('splits large Teams outbound text and returns delivery part metadata', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async ({ text }) => ({
        externalMessageId: `teams:${text.length}`,
      })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    const result = await channel.sendMessage(
      'teams:19:abc@thread.v2',
      'x'.repeat(90000),
    );

    expect(sdkClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(sdkClient.sendMessage).mock.calls[0]?.[0].text.length,
    ).toBeLessThanOrEqual(90000);
    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 2,
        totalParts: 2,
        warnings: ['teams.message.chunked:2:79872'],
      }),
    );
  });

  it('retries Teams outbound payloads by splitting after 413 errors', async () => {
    const sendMessage = vi
      .fn(async () => ({ externalMessageId: 'unused' }))
      .mockRejectedValueOnce({ status: 413, message: 'payload too large' })
      .mockResolvedValueOnce({ externalMessageId: 'teams-msg-a' })
      .mockResolvedValueOnce({ externalMessageId: 'teams-msg-b' });
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage,
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    const result = await channel.sendMessage(
      'teams:19:abc@thread.v2',
      'x'.repeat(10000),
    );

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 2,
        totalParts: 2,
        warnings: ['teams.payload_413_split_retry'],
      }),
    );
  });

  it('retries Teams 413 payloads with code-point-safe byte-budget splits', async () => {
    const emojiHeavy = '🙂'.repeat(2501);
    const sendMessage = vi
      .fn(async () => ({ externalMessageId: 'teams-msg' }))
      .mockRejectedValueOnce({ status: 413, message: 'payload too large' });
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage,
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    const result = await channel.sendMessage(
      'teams:19:abc@thread.v2',
      emojiHeavy,
    );

    expect(sendMessage).toHaveBeenCalledTimes(4);
    const retryParts = vi
      .mocked(sendMessage)
      .mock.calls.slice(1)
      .map(([input]) => input.text);
    expect(retryParts.join('')).toBe(emojiHeavy);
    for (const part of retryParts) {
      expect(part).not.toContain('\uFFFD');
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(5002);
      const firstCodeUnit = part.charCodeAt(0);
      const lastCodeUnit = part.charCodeAt(part.length - 1);
      expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
      expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
    }
    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 3,
        totalParts: 3,
        warnings: ['teams.payload_413_split_retry'],
      }),
    );
  });

  it('throws partial delivery classification when a later Teams chunk fails', async () => {
    const sendMessage = vi
      .fn(async ({ text }) => ({ externalMessageId: `teams:${text.length}` }))
      .mockResolvedValueOnce({ externalMessageId: 'teams-msg-a' })
      .mockRejectedValueOnce(new Error('second part failed'));
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage,
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      makeOpts(),
      sdkClient,
    );
    await channel.connect();

    let thrown: unknown;
    try {
      await channel.sendMessage('teams:19:abc@thread.v2', 'x'.repeat(90000));
    } catch (err) {
      thrown = err;
    }
    const unsentSuffix = vi.mocked(sendMessage).mock.calls[1]?.[0]?.text;
    expect(thrown).toMatchObject({
      name: 'PartialTeamsDeliveryError',
      partialMessageDelivery: true,
      deliveredChunks: 1,
      totalChunks: 2,
      retryTail: {
        canonicalText: unsentSuffix,
        providerPayload: expect.objectContaining({
          provider: 'teams',
          conversationId: '19:abc@thread.v2',
        }),
      },
    });
  });

  it('sends Teams approval cards and accepts Action.Execute decisions from conversation approvers', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => true);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-card-1',
      })),
    };
    const opts = {
      ...makeOpts(),
      isControlApproverAllowed,
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      {
        requestId: 'perm-teams-1',
        sourceAgentFolder: 'teams_engineering',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
        threadId: 'root-message',
      },
    );

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        threadId: 'root-message',
      }),
    );
    await Promise.resolve();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'permission_decision',
        requestId: 'perm-teams-1',
        decision: 'allow_once',
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: true,
        decidedBy: 'Team Admin',
      }),
    );
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'teams',
        conversationJid: 'teams:19:abc@thread.v2',
        userId: 'teams-user-1',
      }),
    );
  });

  it('sends Teams user-question cards and resolves Action.Submit answers from approvers', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => true);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({ externalMessageId: 'teams-q-1' })),
    };
    const opts = { ...makeOpts(), isControlApproverAllowed };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      opts,
      sdkClient,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('teams:19:abc@thread.v2', {
      requestId: 'q-teams-1',
      sourceAgentFolder: 'teams_engineering',
      questions: [
        {
          question: 'Which environment?',
          header: 'Env',
          multiSelect: false,
          options: [
            { label: 'staging', description: 'pre-prod' },
            { label: 'production', description: 'live' },
          ],
        },
      ],
    });

    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: '19:abc@thread.v2' }),
    );
    await Promise.resolve();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'gantry_userq',
        requestId: 'q-teams-1',
        gantry_userq_choice_0: '1',
        gantry_userq_other_0: '',
      },
    });

    await expect(answerPromise).resolves.toEqual({
      requestId: 'q-teams-1',
      answers: { 'Which environment?': 'production' },
      answeredBy: 'Team Admin',
    });
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'teams',
        conversationJid: 'teams:19:abc@thread.v2',
        userId: 'teams-user-1',
      }),
    );
  });

  it('resolves durable Teams user-question answers after restart', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => true);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({ externalMessageId: 'teams-q-1' })),
    };
    const request = {
      requestId: 'q-teams-restart',
      sourceAgentFolder: 'teams_engineering',
      targetJid: 'teams:19:abc@thread.v2',
      questions: [
        {
          question: 'Which environment?',
          header: 'Env',
          multiSelect: false,
          options: [
            { label: 'staging', description: 'pre-prod' },
            { label: 'production', description: 'live' },
          ],
        },
      ],
    };
    const pending = {
      id: 'pending-question-1',
      appId: 'default',
      runId: 'run-1',
      kind: 'question',
      status: 'pending',
      payload: {
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        targetJid: request.targetJid,
        request,
      },
      callbackRoute: null,
      idempotencyKey: 'question:teams_engineering:q-teams-restart',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-18T00:00:00.000Z',
      expiresAt: '2026-06-19T00:00:00.000Z',
      resolvedAt: null,
    };
    const repository = {
      listPendingInteractions: vi.fn(async () => [pending]),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      { ...makeOpts(), isControlApproverAllowed },
      sdkClient,
    );
    await channel.connect();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'gantry_userq',
        requestId: 'q-teams-restart',
        gantry_userq_choice_0: '1',
        gantry_userq_other_0: '',
      },
    });

    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith({
      idempotencyKey: 'question:teams_engineering:q-teams-restart',
      status: 'resolved',
      resolution: { answers: { 'Which environment?': 'production' } },
      approverRef: 'Team Admin',
    });
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'teams',
        conversationJid: 'teams:19:abc@thread.v2',
        userId: 'teams-user-1',
      }),
    );
  });

  it('keeps pending Teams permission prompts unresolved when decision user is unauthorized', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => false);
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-card-2',
      })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      {
        ...makeOpts(),
        isControlApproverAllowed,
      },
      sdkClient,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      {
        requestId: 'perm-teams-unauthorized',
        sourceAgentFolder: 'teams_engineering',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
      },
    );
    await Promise.resolve();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-2', name: 'Viewer' },
      value: {
        data: {
          action: 'permission_decision',
          requestId: 'perm-teams-unauthorized',
          decision: 'allow_once',
        },
      },
    });

    let settled = false;
    void approvalPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sdkClient.sendMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      text: 'You are not allowed to decide this permission request.',
    });

    await channel.disconnect();
    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: false,
        decidedBy: 'system',
        reason: 'Teams channel disconnected',
      }),
    );
  });

  it('creates a channel only when runtime secrets and an SDK client are supplied', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
    };

    await expect(
      createTeamsChannel(makeOpts(), { sdkClient }),
    ).resolves.toBeInstanceOf(TeamsChannel);
  });

  it('creates the runtime channel from configured runtime secret refs', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
    };
    const opts = makeOpts();
    opts.runtimeSettings = () =>
      ({
        providers: { teams: { defaultConnection: 'teams_default' } },
        providerConnections: {
          teams_default: {
            runtimeSecretRefs: {
              client_id: 'gantry-secret:TEAMS_CLIENT_ID',
              client_secret: 'gantry-secret:TEAMS_CLIENT_SECRET',
              tenant_id: 'gantry-secret:TEAMS_TENANT_ID',
            },
          },
        },
      }) as never;
    opts.runtimeSecrets = {
      getSecret: vi.fn(),
      getOptionalSecret: vi.fn(),
      getOptionalSecretAsync: vi.fn(async (ref) =>
        ref.ref === 'gantry-secret:TEAMS_CLIENT_ID'
          ? 'client-id'
          : ref.ref === 'gantry-secret:TEAMS_CLIENT_SECRET'
            ? 'client-secret'
            : ref.ref === 'gantry-secret:TEAMS_TENANT_ID'
              ? 'tenant-id'
              : undefined,
      ),
    };

    await expect(
      createTeamsChannel(opts, { sdkClient }),
    ).resolves.toBeInstanceOf(TeamsChannel);
  });
});
