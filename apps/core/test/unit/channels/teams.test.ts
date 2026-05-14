import { describe, expect, it, vi } from 'vitest';

import {
  getProvider,
  providerForJid,
} from '@core/channels/provider-registry.js';
import '@core/channels/register-builtins.js';
import {
  TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  TeamsChannel,
  type TeamsSdkClient,
  buildTeamsApprovalDescriptorPayload,
  createTeamsChannel,
  normalizeTeamsJid,
  teamsConversationIdFromJid,
} from '@core/channels/teams.js';
import type { ChannelOpts } from '@core/channels/channel-provider.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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

describe('Teams built-in provider', () => {
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
        verb: 'myclaw.permission.allow',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'allow_once',
        }),
      }),
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Allow 5 min for this tool',
        verb: 'myclaw.permission.allow',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'allow_timed_grant',
        }),
      }),
      expect.objectContaining({
        type: 'Action.Execute',
        title: 'Cancel',
        verb: 'myclaw.permission.cancel',
        data: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'cancel',
        }),
      }),
    ]);
    expect(JSON.stringify(payload)).toContain('git status --short');
  });
});

describe('TeamsChannel adapter scaffold', () => {
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
        decision: 'approve',
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
          decision: 'approve',
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

  it('creates a channel only when runtime secrets and an SDK client are supplied', () => {
    const sdkClient: TeamsSdkClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({})),
    };

    expect(createTeamsChannel(makeOpts(), { sdkClient })).toBeInstanceOf(
      TeamsChannel,
    );
  });
});
