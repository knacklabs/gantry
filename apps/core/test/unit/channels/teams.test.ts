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
import { createPermissionBatchRequest } from '@core/channels/permission-batch-coalescer.js';
import type { ChannelOpts } from '@core/channels/channel-provider.js';
import {
  configurePendingInteractionDurability,
  configurePermissionReviewEachDispatcher,
  DurableInteractionPersistenceError,
} from '@core/application/interactions/pending-interaction-durability.js';
import type {
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
  PermissionCallbackScope,
} from '@core/domain/types.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '@core/shared/permission-timeout.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  configurePermissionReviewEachDispatcher(null);
  configurePendingInteractionDurability(null);
  vi.useRealTimers();
});

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(async () => {}),
    onChatMetadata: vi.fn(async () => {}),
    conversationRoutes: vi.fn(() => ({})),
    providerAccountId: 'teams_default',
    runtimeSettings: () =>
      ({
        providerAccounts: {
          teams_default: {
            provider: 'teams',
            runtimeSecretRefs: {
              client_id: 'env:TEAMS_CLIENT_ID',
              client_secret: 'env:TEAMS_CLIENT_SECRET',
              tenant_id: 'env:TEAMS_TENANT_ID',
            },
          },
        },
      }) as never,
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

function configureTeamsPermissionRequest(request: PermissionApprovalRequest) {
  const appId = request.appId || 'default';
  const requestIds = request.permissionBatch?.requestIds || [request.requestId];
  const interactions = requestIds.map((requestId) => ({
    id: `pending-${request.sourceAgentFolder}-${requestId}`,
    appId,
    runId: 'run-1',
    kind: 'permission' as const,
    status: 'pending' as const,
    payload: {
      requestId,
      sourceAgentFolder: request.sourceAgentFolder,
      request: { ...request, requestId },
      targetJid: request.targetJid,
      decisionPolicy: request.decisionPolicy,
    } as Record<string, unknown>,
    callbackRoute: null,
    idempotencyKey: `${appId}:permission:${request.sourceAgentFolder}:${requestId}`,
    approverRef: null,
    resolution: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2099-07-17T00:00:00.000Z',
    resolvedAt: null,
  }));
  const find = (scope: PermissionCallbackScope) =>
    interactions.filter((interaction) => {
      const claim = interaction.payload.permissionCallbackClaim as
        | PermissionCallbackClaim
        | undefined;
      return (
        interaction.appId === scope.appId &&
        interaction.payload.sourceAgentFolder === scope.sourceAgentFolder &&
        (claim?.scope.interactionId === scope.interactionId ||
          interaction.payload.requestId === scope.interactionId ||
          interaction.payload.permissionBatchCallbackId === scope.interactionId)
      );
    });
  const repository = {
    listPendingInteractions: vi.fn(async () => interactions),
    findPendingPermissionInteractions: vi.fn(
      async ({ scope }: { scope: PermissionCallbackScope }) => find(scope),
    ),
    updatePendingInteractionPayload: vi.fn(
      async ({
        idempotencyKey,
        update,
      }: {
        idempotencyKey: string;
        update: (
          payload: Record<string, unknown>,
        ) => Record<string, unknown> | null;
      }) => {
        const interaction = interactions.find(
          (item) => item.idempotencyKey === idempotencyKey,
        );
        if (!interaction) return false;
        const payload = update(interaction.payload);
        if (!payload) return false;
        interaction.payload = payload;
        return true;
      },
    ),
    claimPendingPermissionCallback: vi.fn(
      async ({ claim }: { claim: PermissionCallbackClaim }) => {
        const claimed = find(claim.scope).filter(
          (interaction) =>
            !interaction.payload.permissionCallbackClaim &&
            interaction.payload.permissionCallbackId ===
              claim.match.providerAliases[0] &&
            (claim.match.kind === 'batch'
              ? interaction.payload.permissionBatchCallbackId ===
                claim.scope.interactionId
              : interaction.payload.requestId === claim.scope.interactionId &&
                !interaction.payload.permissionBatchCallbackId),
        );
        for (const interaction of claimed) {
          delete interaction.payload.permissionBatchCallbackId;
          delete interaction.payload.permissionCallbackId;
          interaction.payload.permissionCallbackClaim = claim;
          if (
            claim.match.kind === 'batch' &&
            claim.intent.mode === 'allow_persistent_rule'
          ) {
            const envelope = interaction.payload.permissionRecoveryEnvelope as
              | { batch?: { phase?: string } }
              | undefined;
            if (envelope?.batch) envelope.batch.phase = 'review_each';
          }
        }
        return claimed;
      },
    ),
    releasePendingPermissionCallback: vi.fn(
      async ({ claim }: { claim: PermissionCallbackClaimReference }) => {
        let released = 0;
        for (const interaction of find(claim.scope)) {
          const stored = interaction.payload.permissionCallbackClaim as
            | PermissionCallbackClaim
            | undefined;
          if (stored?.id !== claim.id) continue;
          delete interaction.payload.permissionCallbackClaim;
          if (stored.match.kind === 'batch') {
            interaction.payload.permissionBatchCallbackId =
              stored.match.canonicalId;
          }
          interaction.payload.permissionCallbackId =
            stored.match.providerAliases[0];
          released += 1;
        }
        return released;
      },
    ),
    settlePendingPermissionCallback: vi.fn(
      async ({ claim }: { claim: PermissionCallbackClaimReference }) =>
        find(claim.scope).filter(
          (interaction) =>
            (
              interaction.payload
                .permissionCallbackClaim as PermissionCallbackClaim
            )?.id === claim.id,
        ).length,
    ),
    resolvePendingInteraction: vi.fn(async () => true),
  };
  configurePendingInteractionDurability({ repository: repository as never });
  return repository;
}

function latestTeamsPermissionCallback(sdkClient: TeamsSdkClient) {
  const card = vi
    .mocked(sdkClient.sendAdaptiveCard!)
    .mock.calls.at(-1)?.[0]?.card;
  const data = card?.actions.find(
    (action) => action.data.action === 'permission_decision',
  )?.data;
  if (!data || data.action !== 'permission_decision') {
    throw new Error('Missing Teams permission callback');
  }
  return data.callback;
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
          callback: expect.objectContaining({
            scope: {
              appId: 'default',
              sourceAgentFolder: 'teams_main',
              interactionId: 'perm-1',
            },
          }),
          decision: 'allow_once',
        }),
      }),
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Cancel',
        verb: 'gantry.permission.cancel',
        data: expect.objectContaining({
          callback: expect.objectContaining({
            scope: {
              appId: 'default',
              sourceAgentFolder: 'teams_main',
              interactionId: 'perm-1',
            },
          }),
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
      { providerAccountId: 'teams_default' },
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
      providerAccountId: 'teams_default',
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
      providerAccountId: 'teams_default',
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

  it('keeps a targeted Teams stream usable when an old final update finishes after reset', async () => {
    let resolveOldUpdate: ((value?: unknown) => void) | undefined;
    let cardCount = 0;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: `stream-card-${++cardCount}`,
      })),
      updateAdaptiveCard: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOldUpdate = resolve;
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
    const jid = 'teams:19:abc@thread.v2';
    const threadId = 'root-message';
    await channel.connect();
    await channel.sendStreamingChunk(jid, 'old', {
      threadId,
      generation: 7,
    });

    const oldFinal = channel.sendStreamingChunk(jid, ' final', {
      threadId,
      generation: 7,
      done: true,
    });
    await vi.waitFor(() =>
      expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledTimes(1),
    );
    channel.resetStreaming(jid, { threadId });
    await channel.sendStreamingChunk(jid, 'new', {
      threadId,
      generation: 7,
    });

    resolveOldUpdate?.({});
    await oldFinal;
    await channel.sendStreamingChunk(jid, ' tail', {
      threadId,
      generation: 7,
      done: true,
    });

    expect(sdkClient.updateAdaptiveCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'stream-card-2',
        card: expect.objectContaining({
          body: [expect.objectContaining({ text: 'new tail' })],
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

  it('stops Teams overflow parts when the stream guard changes mid-send', async () => {
    let resolveFirstOverflow!: (value: { externalMessageId: string }) => void;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstOverflow = resolve;
            }),
        )
        .mockResolvedValue({ externalMessageId: 'late-overflow' }),
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
    const jid = 'teams:19:abc@thread.v2';
    const threadId = 'root-message';
    await channel.connect();

    const delivery = channel.sendStreamingChunk(
      jid,
      'x'.repeat(TEAMS_HARD_MESSAGE_BYTES * 3),
      { done: true, generation: 1, threadId },
    );
    await vi.waitFor(() =>
      expect(sdkClient.sendMessage).toHaveBeenCalledOnce(),
    );
    channel.resetStreaming(jid, { threadId });
    resolveFirstOverflow({ externalMessageId: 'first-overflow' });
    await delivery;

    expect(sdkClient.sendMessage).toHaveBeenCalledOnce();
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
      updateAdaptiveCard: vi.fn(async () => ({})),
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

    const request = {
      requestId: 'perm-teams-1',
      sourceAgentFolder: 'teams_engineering',
      decisionPolicy: 'same_channel' as const,
      toolName: 'Bash',
      threadId: 'root-message',
    };
    configureTeamsPermissionRequest(request);
    const approvalPromise = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      request,
    );

    await vi.waitFor(() =>
      expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: '19:abc@thread.v2',
          threadId: 'root-message',
        }),
      ),
    );

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'permission_decision',
        callback: latestTeamsPermissionCallback(sdkClient),
        decision: 'allow_once',
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: true,
        decidedBy: 'teams-user-1',
      }),
    );
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'teams',
        conversationJid: 'teams:19:abc@thread.v2',
        userId: 'teams-user-1',
      }),
    );
    expect(sdkClient.updateAdaptiveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:abc@thread.v2',
        messageId: 'teams-card-1',
      }),
    );
    expect(sdkClient.sendMessage).not.toHaveBeenCalled();
  });

  it('binds a Teams permission batch before delivery and attaches its card id afterward', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined;
    const bindingEvents: string[] = [];
    const pending = ['perm-teams-batch-1', 'perm-teams-batch-2'].map(
      (requestId) => ({
        id: `pending-${requestId}`,
        appId: 'default',
        runId: 'run-1',
        kind: 'permission' as const,
        status: 'pending' as const,
        payload: {
          requestId,
          sourceAgentFolder: 'teams_engineering',
          request: {
            requestId,
            sourceAgentFolder: 'teams_engineering',
            decisionPolicy: 'same_channel',
            targetJid: 'teams:19:abc@thread.v2',
            toolName: 'Bash',
          },
        } as Record<string, unknown>,
        callbackRoute: null,
        idempotencyKey: `default:permission:teams_engineering:${requestId}`,
        approverRef: null,
        resolution: null,
        createdAt: '2026-07-16T00:00:00.000Z',
        expiresAt: '2099-07-17T00:00:00.000Z',
        resolvedAt: null,
      }),
    );
    const repository = {
      listPendingInteractions: vi.fn(async () => pending),
      findPendingPermissionInteractions: vi.fn(
        async ({ scope }: { scope: PermissionCallbackScope }) =>
          pending.filter(
            (interaction) =>
              interaction.appId === scope.appId &&
              interaction.payload.sourceAgentFolder ===
                scope.sourceAgentFolder &&
              (interaction.payload.permissionBatchCallbackId ===
                scope.interactionId ||
                (
                  interaction.payload
                    .permissionCallbackClaim as PermissionCallbackClaim
                )?.scope.interactionId === scope.interactionId),
          ),
      ),
      updatePendingInteractionPayload: vi.fn(
        async (input: {
          idempotencyKey: string;
          update: (
            payload: Record<string, unknown>,
          ) => Record<string, unknown> | null;
        }) => {
          const interaction = pending.find(
            (item) => item.idempotencyKey === input.idempotencyKey,
          );
          if (!interaction) return false;
          const payload = input.update(interaction.payload);
          if (!payload) return false;
          interaction.payload = payload;
          bindingEvents.push(
            `${input.idempotencyKey}:${String(payload.externalPromptMessageId ?? 'pending')}`,
          );
          return true;
        },
      ),
      claimPendingPermissionCallback: vi.fn(
        async ({ claim }: { claim: PermissionCallbackClaim }) => {
          const claimed = [];
          for (const interaction of pending) {
            if (
              interaction.payload.permissionBatchCallbackId !==
                claim.scope.interactionId ||
              interaction.payload.permissionCallbackId !==
                claim.match.providerAliases[0]
            ) {
              continue;
            }
            delete interaction.payload.permissionBatchCallbackId;
            delete interaction.payload.permissionCallbackId;
            interaction.payload.permissionCallbackClaim = claim;
            claimed.push(interaction);
          }
          return claimed;
        },
      ),
    };
    configurePendingInteractionDurability({ repository: repository as never });
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => {
        bindingEvents.push('send');
        return { externalMessageId: 'teams-batch-card' };
      }),
      updateAdaptiveCard: vi.fn(async () => ({})),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      { ...makeOpts(), isControlApproverAllowed: vi.fn(async () => true) },
      sdkClient,
    );
    await channel.connect();
    const batch = createPermissionBatchRequest(
      pending.map((interaction) => ({
        requestId: String(interaction.payload.requestId),
        sourceAgentFolder: 'teams_engineering',
        decisionPolicy: 'same_channel',
        targetJid: 'teams:19:abc@thread.v2',
        toolName: 'Bash',
      })),
      ['1. Command', '2. Command'],
    );

    const approvalPromise = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      batch,
    );
    await vi.waitFor(() =>
      expect(repository.updatePendingInteractionPayload).toHaveBeenCalledTimes(
        4,
      ),
    );

    expect(bindingEvents).toEqual([
      'default:permission:teams_engineering:perm-teams-batch-1:pending',
      'default:permission:teams_engineering:perm-teams-batch-2:pending',
      'send',
      'default:permission:teams_engineering:perm-teams-batch-1:teams-batch-card',
      'default:permission:teams_engineering:perm-teams-batch-2:teams-batch-card',
    ]);
    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'permission_decision',
        callback: latestTeamsPermissionCallback(sdkClient),
        decision: 'allow_once',
      },
    });

    await expect(approvalPromise).resolves.toMatchObject({ approved: true });
    expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledTimes(1);
  });

  it('recovers Review each for a Teams batch whose original requests cannot be bulk-approved', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'unused-live-card',
      })),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      { ...makeOpts(), isControlApproverAllowed: vi.fn(async () => true) },
      sdkClient,
    );
    await channel.connect();
    const requests: PermissionApprovalRequest[] = ['one', 'two'].map(
      (suffix) => ({
        requestId: `perm-teams-recovered-${suffix}`,
        sourceAgentFolder: 'teams_engineering',
        targetJid: 'teams:19:abc@thread.v2',
        toolName: 'Bash',
        decisionOptions: ['allow_once', 'cancel'],
      }),
    );
    const batch = createPermissionBatchRequest(requests, [
      '1. Command',
      '2. Command',
    ]);
    const repository = configureTeamsPermissionRequest(batch);
    const providerAlias = 'teams-recovered-batch';
    const interactions = await repository.listPendingInteractions({
      appId: 'default',
    });
    const recoveryEnvelope = {
      version: 1 as const,
      renderedDecisionOptions: ['allow_persistent_rule', 'cancel'] as const,
      targetJid: 'teams:19:abc@thread.v2',
      approvalContextJid: 'teams:19:abc@thread.v2',
      threadId: null,
      decisionPolicy: null,
      renderedRequest: batch,
      members: requests.map((request, index) => ({
        callback: {
          appId: 'default',
          sourceAgentFolder: request.sourceAgentFolder,
          requestId: request.requestId,
          index,
        },
        request,
      })),
      batch: { canonicalId: batch.requestId, phase: 'decision' as const },
    };
    interactions.forEach((interaction, index) => {
      interaction.payload.request = requests[index];
      interaction.payload.permissionRecoveryEnvelope = recoveryEnvelope;
      interaction.payload.permissionBatchCallbackId = batch.requestId;
      interaction.payload.permissionCallbackId = providerAlias;
      interaction.payload.externalPromptMessageId = 'teams-recovered-card';
      interaction.payload.externalPromptConversationId = '19:abc@thread.v2';
    });
    const dispatchRecoveredMember = vi.fn(
      async (request: PermissionApprovalRequest) => ({
        delivered: true as const,
        decision: {
          approved: false,
          mode: 'cancel' as const,
          decidedBy: 'teams-user-1',
          permissionCallbackClaim: {
            id: `member-claim-${request.requestId}`,
            scope: {
              appId: 'default',
              sourceAgentFolder: request.sourceAgentFolder,
              interactionId: request.requestId,
            },
          },
        },
      }),
    );
    configurePermissionReviewEachDispatcher(dispatchRecoveredMember);

    await startInput?.onMessage({
      id: 'teams-recovered-card',
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'permission_decision',
        callback: {
          providerAlias,
          scope: {
            appId: 'default',
            sourceAgentFolder: 'teams_engineering',
            interactionId: batch.requestId,
          },
          matchKind: 'batch',
        },
        decision: 'allow_persistent_rule',
      },
    });

    expect(sdkClient.sendMessage).toHaveBeenCalledWith({
      conversationId: '19:abc@thread.v2',
      text: 'Reviewing each permission request.',
    });
    expect(sdkClient.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/cancel|denied/i),
      }),
    );
    expect(repository.settlePendingPermissionCallback).toHaveBeenCalledOnce();
    expect(dispatchRecoveredMember).toHaveBeenCalledTimes(2);
  });

  it('resolves every Teams permission waiter on disconnect when durable claims are retryable', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: globalThis.crypto.randomUUID(),
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
    const firstRequest: PermissionApprovalRequest = {
      requestId: 'perm-teams-disconnect-first',
      sourceAgentFolder: 'teams_engineering',
      toolName: 'Bash',
    };
    const firstRepository = configureTeamsPermissionRequest(firstRequest);
    const first = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      firstRequest,
    );
    await vi.waitFor(() =>
      expect(
        firstRepository.updatePendingInteractionPayload,
      ).toHaveBeenCalledTimes(2),
    );
    const secondRequest: PermissionApprovalRequest = {
      requestId: 'perm-teams-disconnect-second',
      sourceAgentFolder: 'teams_engineering',
      toolName: 'Bash',
    };
    const repository = configureTeamsPermissionRequest(secondRequest);
    const second = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      secondRequest,
    );
    await vi.waitFor(() =>
      expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledTimes(2),
    );
    repository.claimPendingPermissionCallback.mockRejectedValue(
      new Error('database unavailable'),
    );

    await channel.disconnect();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'Teams channel disconnected',
      }),
      expect.objectContaining({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'Teams channel disconnected',
      }),
    ]);
  });

  it('preserves a Teams permission waiter owned by an in-flight winner on disconnect', async () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({ externalMessageId: 'card-1' })),
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
    const request: PermissionApprovalRequest = {
      requestId: 'perm-teams-disconnect-winner',
      sourceAgentFolder: 'teams_engineering',
      toolName: 'Bash',
    };
    const repository = configureTeamsPermissionRequest(request);
    const approval = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      request,
    );
    await vi.waitFor(() =>
      expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledOnce(),
    );
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'teams_engineering',
      interactionId: request.requestId,
    };
    repository.claimPendingPermissionCallback.mockResolvedValue([]);
    repository.findPendingPermissionInteractions.mockResolvedValue([
      {
        payload: {
          permissionCallbackClaim: {
            id: 'holder',
            scope,
            intent: {
              mode: 'allow_once',
              approverRef: 'owner',
              decidedAt: '2026-07-17T00:00:00.000Z',
            },
            match: {
              kind: 'individual',
              canonicalId: request.requestId,
              providerAliases: [],
            },
          },
        },
      },
    ] as never);
    let resolved = false;
    void approval.then(() => {
      resolved = true;
    });

    await channel.disconnect();
    await Promise.resolve();

    expect(resolved).toBe(false);
    const prompts = (channel as any).pendingPermissionPrompts as Map<
      string,
      any
    >;
    expect(prompts.size).toBe(1);
    const pending = prompts.values().next().value;
    clearTimeout(pending.timer);
    pending.resolve({ approved: true, mode: 'allow_once', decidedBy: 'owner' });
    prompts.clear();
    await approval;
  });

  it('resolves the Teams waiter after a no-holder claim exhausts bounded retries', async () => {
    vi.useFakeTimers();
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-timeout-retryable-card',
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
    const request = {
      requestId: 'perm-teams-timeout-retryable',
      sourceAgentFolder: 'teams_engineering',
      toolName: 'Bash',
    };
    const repository = configureTeamsPermissionRequest(request);
    repository.claimPendingPermissionCallback.mockResolvedValue([]);

    const approval = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      request,
    );
    await vi.advanceTimersByTimeAsync(PERMISSION_APPROVAL_TIMEOUT_MS * 2);

    await expect(approval).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'timed out',
    });
    expect(repository.claimPendingPermissionCallback).toHaveBeenCalledTimes(3);
    expect((channel as any).pendingPermissionPrompts.size).toBe(0);
    await channel.disconnect();
  });

  it('releases and retries a Teams permission when card terminalization fails', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('fallback failed'))
        .mockResolvedValueOnce({}),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-retry-card',
      })),
      updateAdaptiveCard: vi.fn(async () => {
        throw new Error('update failed');
      }),
    };
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      { ...makeOpts(), isControlApproverAllowed: vi.fn(async () => true) },
      sdkClient,
    );
    await channel.connect();
    const request = {
      requestId: 'perm-teams-terminalization-retry',
      sourceAgentFolder: 'teams_engineering',
      decisionPolicy: 'same_channel' as const,
      toolName: 'Bash',
    };
    const repository = configureTeamsPermissionRequest(request);
    const approval = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      request,
    );
    await vi.waitFor(() =>
      expect(sdkClient.sendAdaptiveCard).toHaveBeenCalled(),
    );
    const value = {
      action: 'permission_decision',
      callback: latestTeamsPermissionCallback(sdkClient),
      decision: 'allow_once',
    };

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value,
    });
    let settled = false;
    void approval.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(repository.releasePendingPermissionCallback).toHaveBeenCalledOnce();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value,
    });
    await expect(approval).resolves.toMatchObject({ approved: true });
    expect(repository.claimPendingPermissionCallback).toHaveBeenCalledTimes(2);
  });

  it('settles a Teams batch when its post-send binding was already consumed', async () => {
    vi.useFakeTimers();
    const pending = ['perm-teams-race-1', 'perm-teams-race-2'].map(
      (requestId) => ({
        kind: 'permission' as const,
        status: 'pending' as const,
        idempotencyKey: `default:permission:teams_engineering:${requestId}`,
        payload: {
          requestId,
          sourceAgentFolder: 'teams_engineering',
          request: {
            requestId,
            sourceAgentFolder: 'teams_engineering',
            targetJid: 'teams:19:abc@thread.v2',
            toolName: 'Bash',
          },
        },
      }),
    );
    const repository = {
      listPendingInteractions: vi
        .fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce([]),
      updatePendingInteractionPayload: vi.fn(async ({ update }) =>
        Boolean(update(pending[0]!.payload)),
      ),
    };
    configurePendingInteractionDurability({ repository: repository as never });
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-raced-card',
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
    const batch = createPermissionBatchRequest(
      pending.map((interaction) => ({
        requestId: interaction.payload.requestId,
        sourceAgentFolder: interaction.payload.sourceAgentFolder,
        targetJid: 'teams:19:abc@thread.v2',
        toolName: 'Bash',
      })),
      ['1. Command', '2. Command'],
    );

    await expect(
      channel.requestPermissionApproval('teams:19:abc@thread.v2', batch),
    ).resolves.toEqual({
      approved: false,
      reason: 'This permission request was already decided.',
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(
      (
        channel as unknown as {
          pendingPermissionPrompts: Map<string, unknown>;
        }
      ).pendingPermissionPrompts.size,
    ).toBe(0);
  });

  it('propagates a typed Teams post-send binding failure and retains the live waiter', async () => {
    vi.useFakeTimers();
    const pending = {
      kind: 'permission' as const,
      status: 'pending' as const,
      idempotencyKey:
        'default:permission:teams_engineering:perm-teams-post-send-failure',
      payload: {
        requestId: 'perm-teams-post-send-failure',
        sourceAgentFolder: 'teams_engineering',
        request: {
          requestId: 'perm-teams-post-send-failure',
          sourceAgentFolder: 'teams_engineering',
          targetJid: 'teams:19:abc@thread.v2',
          toolName: 'Bash',
        },
      } as Record<string, unknown>,
    };
    let updateCount = 0;
    configurePendingInteractionDurability({
      repository: {
        listPendingInteractions: vi.fn(async () => [pending]),
        updatePendingInteractionPayload: vi.fn(async ({ update }) => {
          updateCount += 1;
          if (updateCount === 2) throw new Error('database unavailable');
          const payload = update(pending.payload);
          if (!payload) return false;
          pending.payload = payload;
          return true;
        }),
      } as never,
    });
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-post-send-failure-card',
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

    await expect(
      channel.requestPermissionApproval('teams:19:abc@thread.v2', {
        requestId: 'perm-teams-post-send-failure',
        sourceAgentFolder: 'teams_engineering',
        targetJid: 'teams:19:abc@thread.v2',
        toolName: 'Bash',
      }),
    ).rejects.toBeInstanceOf(DurableInteractionPersistenceError);
    expect((channel as any).pendingPermissionPrompts.size).toBe(1);
    await channel.disconnect();
  });

  it('sends Teams user-question cards and resolves Action.Submit answers from approvers', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined =
      undefined;
    const isControlApproverAllowed = vi.fn(async () => true);
    const lifecycleEvents: string[] = [];
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

    const questionRequest = {
      requestId: 'q-teams-1',
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
    const pendingQuestion = {
      appId: 'default',
      kind: 'question' as const,
      status: 'pending' as const,
      idempotencyKey: 'default:question:teams_engineering:q-teams-1',
      payload: {
        requestId: questionRequest.requestId,
        sourceAgentFolder: questionRequest.sourceAgentFolder,
        request: questionRequest,
        questionRecoveryEnvelope: {
          version: 1,
          targetJid: questionRequest.targetJid,
          threadId: null,
          request: questionRequest,
          nextQuestionIndex: 0,
          callbacks: {},
          selections: [],
          answers: {},
          completedQuestionIndexes: [],
          deliveredQuestionIndexes: [],
          otherPrompts: {},
        },
      } as Record<string, unknown>,
    };
    configurePendingInteractionDurability({
      repository: {
        listPendingInteractions: vi.fn(async () => [pendingQuestion]),
        updatePendingInteractionPayload: vi.fn(async ({ update }) => {
          const payload = update(pendingQuestion.payload);
          if (!payload) return false;
          pendingQuestion.payload = payload;
          const envelope = payload.questionRecoveryEnvelope as {
            answers: Record<string, string | string[]>;
          };
          if (envelope.answers['Which environment?'] === 'production') {
            lifecycleEvents.push('persist');
          }
          return true;
        }),
      } as never,
    });
    const answerPromise = channel.requestUserAnswer(
      'teams:19:abc@thread.v2',
      questionRequest,
    );
    void answerPromise.then(() => lifecycleEvents.push('resolve'));
    await vi.waitFor(() =>
      expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: '19:abc@thread.v2' }),
      ),
    );
    const callback = vi.mocked(sdkClient.sendAdaptiveCard).mock.calls[0]![0]
      .card.actions[0]!.data.callback;
    await Promise.resolve();

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'gantry_userq',
        callback,
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
    expect(lifecycleEvents).toEqual(['persist', 'resolve']);
    expect(pendingQuestion.payload.questionRecoveryEnvelope).toMatchObject({
      answers: { 'Which environment?': 'production' },
      completedQuestionIndexes: [0],
      nextQuestionIndex: null,
    });
  });

  it('persists empty Teams answers and completed indexes before timeout resolution', async () => {
    vi.useFakeTimers();
    const lifecycleEvents: string[] = [];
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({
        externalMessageId: 'teams-timeout-question-card',
      })),
    };
    const request = {
      requestId: 'q-teams-timeout',
      sourceAgentFolder: 'teams_engineering',
      targetJid: 'teams:19:abc@thread.v2',
      questions: [
        {
          question: 'Continue?',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'Continue' }],
        },
        {
          question: 'Which checks?',
          multiSelect: true,
          options: [{ label: 'Unit', description: 'Run unit tests' }],
        },
      ],
    };
    const pendingQuestion = {
      appId: 'default',
      kind: 'question' as const,
      status: 'pending' as const,
      idempotencyKey: 'default:question:teams_engineering:q-teams-timeout',
      payload: {
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        questionRecoveryEnvelope: {
          version: 1,
          targetJid: request.targetJid,
          threadId: null,
          request,
          nextQuestionIndex: 0,
          callbacks: {},
          selections: [],
          answers: {},
          completedQuestionIndexes: [],
          deliveredQuestionIndexes: [],
          otherPrompts: {},
        },
      } as Record<string, unknown>,
    };
    configurePendingInteractionDurability({
      repository: {
        listPendingInteractions: vi.fn(async () => [pendingQuestion]),
        updatePendingInteractionPayload: vi.fn(async ({ update }) => {
          const payload = update(pendingQuestion.payload);
          if (!payload) return false;
          pendingQuestion.payload = payload;
          const envelope = payload.questionRecoveryEnvelope as {
            completedQuestionIndexes: number[];
          };
          if (envelope.completedQuestionIndexes.length === 2) {
            lifecycleEvents.push('persist');
          }
          return true;
        }),
      } as never,
    });
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

    const answer = channel.requestUserAnswer('teams:19:abc@thread.v2', request);
    void answer.then(() => lifecycleEvents.push('resolve'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PERMISSION_APPROVAL_TIMEOUT_MS);

    await expect(answer).resolves.toEqual({
      requestId: request.requestId,
      answers: { 'Continue?': '', 'Which checks?': [] },
      answeredBy: 'system',
    });
    expect(lifecycleEvents).toEqual(['persist', 'resolve']);
    expect(pendingQuestion.payload.questionRecoveryEnvelope).toMatchObject({
      answers: { 'Continue?': '', 'Which checks?': [] },
      completedQuestionIndexes: [0, 1],
      nextQuestionIndex: null,
    });
    await channel.disconnect();
  });

  it('renders only unfinished Teams questions during durable recovery', async () => {
    let startInput: Parameters<TeamsSdkClient['start']>[0] | undefined;
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async (input) => {
        startInput = input;
      }),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
      sendAdaptiveCard: vi.fn(async () => ({ externalMessageId: 'teams-q-2' })),
    };
    const request = {
      requestId: 'q-teams-recovery-index',
      sourceAgentFolder: 'teams_engineering',
      targetJid: 'teams:19:abc@thread.v2',
      recoveryStartIndex: 1,
      questions: [
        {
          question: 'Already answered?',
          multiSelect: false,
          options: [{ label: 'done', description: '' }],
        },
        {
          question: 'Still needed?',
          multiSelect: false,
          options: [{ label: 'continue', description: '' }],
        },
      ],
    };
    const pendingQuestion = {
      appId: 'default',
      kind: 'question' as const,
      status: 'pending' as const,
      idempotencyKey:
        'default:question:teams_engineering:q-teams-recovery-index',
      payload: {
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        questionRecoveryEnvelope: {
          version: 1,
          targetJid: request.targetJid,
          threadId: null,
          request,
          nextQuestionIndex: 1,
          callbacks: {},
          selections: [],
          answers: { 'Already answered?': 'done' },
          completedQuestionIndexes: [0],
          deliveredQuestionIndexes: [0],
          otherPrompts: {},
        },
      } as Record<string, unknown>,
    };
    configurePendingInteractionDurability({
      repository: {
        listPendingInteractions: vi.fn(async () => [pendingQuestion]),
        updatePendingInteractionPayload: vi.fn(async ({ update }) => {
          const payload = update(pendingQuestion.payload);
          if (!payload) return false;
          pendingQuestion.payload = payload;
          return true;
        }),
      } as never,
    });
    const channel = new TeamsChannel(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      { ...makeOpts(), isControlApproverAllowed: vi.fn(async () => true) },
      sdkClient,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer(
      'teams:19:abc@thread.v2',
      request,
    );
    await vi.waitFor(() =>
      expect(sdkClient.sendAdaptiveCard).toHaveBeenCalledOnce(),
    );
    const card = vi.mocked(sdkClient.sendAdaptiveCard).mock.calls[0]![0].card;
    expect(card.body).not.toContainEqual(
      expect.objectContaining({ text: 'Already answered?' }),
    );
    expect(card.body).toContainEqual(
      expect.objectContaining({ text: 'Still needed?' }),
    );
    expect(card.body).toContainEqual(
      expect.objectContaining({ id: 'gantry_userq_choice_1' }),
    );
    const callback = card.actions[0]!.data.callback;
    expect(callback.questionIndex).toBe(1);

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-1', name: 'Team Admin' },
      value: {
        action: 'gantry_userq',
        callback,
        gantry_userq_choice_1: '0',
        gantry_userq_other_1: '',
      },
    });

    await expect(answerPromise).resolves.toEqual({
      requestId: request.requestId,
      answers: { 'Still needed?': 'continue' },
      answeredBy: 'Team Admin',
    });
    expect(pendingQuestion.payload.questionRecoveryEnvelope).toMatchObject({
      answers: {
        'Already answered?': 'done',
        'Still needed?': 'continue',
      },
      completedQuestionIndexes: [0, 1],
      nextQuestionIndex: null,
    });
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
    const requests = [
      request,
      { ...request, sourceAgentFolder: 'teams_operations' },
    ];
    const callbacks = requests.map((candidate, index) => ({
      providerAlias: `teams-question-${index + 1}`,
      scope: {
        appId: 'default',
        sourceAgentFolder: candidate.sourceAgentFolder,
        interactionId: candidate.requestId,
      },
      questionIndex: 0,
    }));
    const pending = requests.map((candidate, index) => ({
      id: `pending-question-${index + 1}`,
      appId: 'default',
      runId: 'run-1',
      kind: 'question',
      status: 'pending',
      payload: {
        requestId: candidate.requestId,
        sourceAgentFolder: candidate.sourceAgentFolder,
        targetJid: candidate.targetJid,
        request: candidate,
        questionRecoveryEnvelope: {
          version: 1,
          targetJid: candidate.targetJid,
          threadId: null,
          request: candidate,
          nextQuestionIndex: 0,
          callbacks: {
            [callbacks[index]!.providerAlias]: {
              appId: 'default',
              sourceAgentFolder: candidate.sourceAgentFolder,
              requestId: candidate.requestId,
              questionIndex: 0,
            },
          },
          selections: [],
          answers: {},
          completedQuestionIndexes: [],
          deliveredQuestionIndexes: [0],
          otherPrompts: {},
        },
      },
      callbackRoute: null,
      idempotencyKey: `default:question:${candidate.sourceAgentFolder}:${candidate.requestId}`,
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-18T00:00:00.000Z',
      expiresAt: '2026-06-19T00:00:00.000Z',
      resolvedAt: null,
    }));
    const repository = {
      listPendingInteractions: vi.fn(async () => pending),
      updatePendingInteractionPayload: vi.fn(
        async ({ idempotencyKey, update }) => {
          const interaction = pending.find(
            (candidate) => candidate.idempotencyKey === idempotencyKey,
          );
          if (!interaction) return false;
          const payload = update(interaction.payload);
          if (!payload) return false;
          interaction.payload = payload;
          return true;
        },
      ),
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

    for (const [index, callback] of callbacks.entries()) {
      await startInput?.onMessage({
        conversationId: '19:abc@thread.v2',
        from: { id: 'teams-user-1', name: 'Team Admin' },
        value: {
          action: 'gantry_userq',
          callback,
          gantry_userq_choice_0: String(index),
          gantry_userq_other_0: '',
        },
      });
    }

    expect(repository.resolvePendingInteraction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: 'default:question:teams_engineering:q-teams-restart',
        resolution: { answers: { 'Which environment?': 'staging' } },
      }),
    );
    expect(repository.resolvePendingInteraction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: 'default:question:teams_operations:q-teams-restart',
        resolution: { answers: { 'Which environment?': 'production' } },
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

    const request = {
      requestId: 'perm-teams-unauthorized',
      sourceAgentFolder: 'teams_engineering',
      decisionPolicy: 'same_channel' as const,
      toolName: 'Bash',
    };
    configureTeamsPermissionRequest(request);
    const approvalPromise = channel.requestPermissionApproval(
      'teams:19:abc@thread.v2',
      request,
    );
    await vi.waitFor(() =>
      expect(sdkClient.sendAdaptiveCard).toHaveBeenCalled(),
    );

    await startInput?.onMessage({
      conversationId: '19:abc@thread.v2',
      from: { id: 'teams-user-2', name: 'Viewer' },
      value: {
        data: {
          action: 'permission_decision',
          callback: latestTeamsPermissionCallback(sdkClient),
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
        providerAccounts: {
          teams_default: {
            provider: 'teams',
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
