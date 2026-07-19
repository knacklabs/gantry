import { afterEach, describe, expect, it, vi } from 'vitest';

const durabilityMocks = vi.hoisted(() => ({
  DurableInteractionPersistenceError: class DurableInteractionPersistenceError extends Error {
    constructor(message: string, cause?: unknown) {
      super(message, cause === undefined ? undefined : { cause });
      this.name = 'DurableInteractionPersistenceError';
    }
  },
  bindPendingPermissionInteractionMessage: vi.fn(async () => true),
  claimPermissionInteractionCallback: vi.fn(async (input: any) => ({
    status: 'claimed',
    claim: input.recoveredClaim ?? { id: 'claim-1', scope: input.scope },
    ...(input.recoveredClaim ? { persistedClaim: input.recoveredClaim } : {}),
  })),
  findDurablePermissionInteractionByPromptMessage: vi.fn(),
  findDurablePermissionInteractionByRequestId: vi.fn(),
  recoverDurablePermissionDecision: vi.fn(),
  recordDurableQuestionAnswerProgress: vi.fn(async () => true),
  releasePermissionInteractionCallback: vi.fn(async () => true),
  resolveDurablePermissionInteractionByRequestId: vi.fn(),
  resolveDurableQuestionInteractionByRequestId: vi.fn(),
}));

vi.mock(
  '@core/application/interactions/pending-interaction-durability.js',
  () => durabilityMocks,
);

import {
  createDiscordChannel,
  DiscordChannel,
} from '@core/channels/discord.js';
import {
  parsePermissionCustomId,
  permissionCustomId,
} from '@core/channels/discord-components.js';
import { createPermissionBatchRequest } from '@core/channels/permission-batch-coalescer.js';
import {
  consume as consumeDiscordPermissionPrompt,
  pending as pendingDiscordPermissionPrompt,
  settle as settleDiscordPermissionPrompt,
} from '@core/channels/discord-permission-prompt-settlement.js';
import type { ChannelOpts } from '@core/channels/channel-provider.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '@core/shared/permission-timeout.js';

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function opts(overrides: Partial<ChannelOpts> = {}): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function discordPermissionCallback(
  interactionId: string,
  providerAlias = `alias-${interactionId}`,
) {
  return {
    providerAlias,
    scope: {
      appId: 'default',
      sourceAgentFolder: 'main_agent',
      interactionId,
    },
    matchKind: interactionId.startsWith('batch:')
      ? ('batch' as const)
      : ('individual' as const),
  };
}

function latestDiscordPermissionAlias(): string {
  return durabilityMocks.bindPendingPermissionInteractionMessage.mock.calls.at(
    -1,
  )?.[0].callbackId;
}

describe('DiscordChannel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    durabilityMocks.findDurablePermissionInteractionByRequestId.mockReset();
    durabilityMocks.bindPendingPermissionInteractionMessage.mockReset();
    durabilityMocks.bindPendingPermissionInteractionMessage.mockResolvedValue(
      true,
    );
    durabilityMocks.findDurablePermissionInteractionByPromptMessage.mockReset();
    durabilityMocks.recoverDurablePermissionDecision.mockReset();
    durabilityMocks.claimPermissionInteractionCallback
      .mockReset()
      .mockImplementation(async (input: any) => ({
        status: 'claimed',
        claim: input.recoveredClaim ?? { id: 'claim-1', scope: input.scope },
        ...(input.recoveredClaim
          ? { persistedClaim: input.recoveredClaim }
          : {}),
      }));
    durabilityMocks.releasePermissionInteractionCallback
      .mockReset()
      .mockResolvedValue(true);
    durabilityMocks.recordDurableQuestionAnswerProgress
      .mockReset()
      .mockResolvedValue(true);
    durabilityMocks.resolveDurablePermissionInteractionByRequestId.mockReset();
    durabilityMocks.resolveDurableQuestionInteractionByRequestId
      .mockReset()
      .mockResolvedValue(true);
  });

  it('creates the runtime channel from configured runtime secret refs', async () => {
    const channel = await createDiscordChannel(
      opts({
        conversationRoutes: vi.fn(() => ({})),
        providerAccountId: 'discord_default',
        runtimeSettings: () =>
          ({
            providers: { discord: { enabled: true } },
            providerAccounts: {
              discord_default: {
                agentId: 'default',
                provider: 'discord',
                label: 'Discord',
                runtimeSecretRefs: {
                  bot_token: 'gantry-secret:DISCORD_BOT_TOKEN',
                  application_id: 'gantry-secret:DISCORD_APPLICATION_ID',
                },
              },
            },
          }) as never,
        runtimeSecrets: {
          getSecret: vi.fn(),
          getOptionalSecret: vi.fn(),
          getOptionalSecretAsync: vi.fn(async (ref) =>
            ref.ref === 'gantry-secret:DISCORD_BOT_TOKEN'
              ? 'bot-token'
              : ref.ref === 'gantry-secret:DISCORD_APPLICATION_ID'
                ? 'app-id'
                : undefined,
          ),
        },
      }),
    );

    expect(channel).toBeInstanceOf(DiscordChannel);
  });

  it('sends messages through Discord REST with Stop buttons', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.sendMessage('dc:channel-1', 'Working', {
        actionAffordances: [
          { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
        ],
      }),
    ).resolves.toMatchObject({ externalMessageId: 'message-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          content: 'Working',
          allowed_mentions: { parse: [] },
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 4,
                  label: 'Stop',
                  custom_id: 'gantry:live_stop:token-1',
                },
              ],
            },
          ],
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('sends messages through Discord REST with scheduler retry buttons', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.sendMessage('dc:channel-1', 'Paused after failures', {
        actionAffordances: [
          { kind: 'scheduler_run_now', label: 'Retry now', jobId: 'job-1' },
          { kind: 'scheduler_pause_job', label: 'Pause job', jobId: 'job-1' },
        ],
      }),
    ).resolves.toMatchObject({ externalMessageId: 'message-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          content: 'Paused after failures',
          allowed_mentions: { parse: [] },
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 1,
                  label: 'Retry now',
                  custom_id: 'gantry:scheduler_run_now:job-1',
                },
              ],
            },
          ],
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it('skips Discord scheduler retry buttons when the job id cannot fit custom_id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.sendMessage('dc:channel-1', 'Paused after failures', {
      actionAffordances: [
        {
          kind: 'scheduler_run_now',
          label: 'Retry now',
          jobId: 'j'.repeat(90),
        },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body || '{}'));
    expect(body.components).toBeUndefined();
    fetchMock.mockRestore();
  });

  it('adds Discord reactions idempotently', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({}));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.addReaction('dc:channel-1', 'message-1', 'seen');
    await channel.addReaction('dc:channel-1', 'message-1', 'seen');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages/message-1/reactions/%F0%9F%91%80/@me',
      expect.objectContaining({ method: 'PUT' }),
    );
    fetchMock.mockRestore();
  });

  it('uploads message files with Discord multipart delivery', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ id: 'file-message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.sendMessage('dc:channel-1', 'Report attached', {
      files: [
        {
          filename: 'report.txt',
          contentType: 'text/plain',
          sizeBytes: 6,
          content: new TextEncoder().encode('report'),
        },
      ],
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('payload_json')).toContain('report.txt');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'content-type',
    );
    fetchMock.mockRestore();
  });

  it('uploads valid Discord files on the user message before oversized warnings', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'file-message-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'warning-message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.sendMessage('dc:channel-1', 'Report attached', {
      files: [
        {
          filename: 'report.txt',
          contentType: 'text/plain',
          sizeBytes: 6,
          content: new TextEncoder().encode('report'),
        },
        {
          filename: 'large.txt',
          contentType: 'text/plain',
          sizeBytes: 26 * 1024 * 1024,
          content: new Uint8Array(),
        },
      ],
    });

    const payload = (fetchMock.mock.calls[0]?.[1]?.body as FormData).get(
      'payload_json',
    );
    expect(payload).toContain('Report attached');
    expect(payload).toContain('report.txt');
    const warning = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(warning.content).toBe(
      'Attachment unavailable in Discord: large.txt exceeds 25 MB.',
    );
    fetchMock.mockRestore();
  });

  it('keeps Discord text delivery when multipart file upload fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce(jsonResponse({ id: 'text-message-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'warning-message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.sendMessage('dc:channel-1', 'Report attached', {
        files: [
          {
            filename: 'report.txt',
            contentType: 'text/plain',
            sizeBytes: 6,
            content: new TextEncoder().encode('report'),
          },
        ],
      }),
    ).resolves.toMatchObject({ externalMessageId: 'text-message-1' });

    const textBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(textBody.content).toBe('Report attached');
    const warningBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(warningBody.content).toBe(
      'Attachment unavailable in Discord: file upload failed.',
    );
    fetchMock.mockRestore();
  });

  it('keeps Discord text delivery when files exceed the upload cap', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.sendMessage('dc:channel-1', 'Report attached', {
      files: [
        {
          filename: 'large.txt',
          contentType: 'text/plain',
          sizeBytes: 26 * 1024 * 1024,
          content: new Uint8Array(),
        },
      ],
    });

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        content: 'Report attached',
        allowed_mentions: { parse: [] },
        components: undefined,
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        content: 'Attachment unavailable in Discord: large.txt exceeds 25 MB.',
        allowed_mentions: { parse: [] },
        components: undefined,
      }),
    );
    fetchMock.mockRestore();
  });

  it('renders todo messages in place with Stop buttons', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'todo-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'todo-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.renderAgentTodo('dc:channel-1', {
      headline: 'Searching the web',
      status: 'running',
      elapsed: '2m 14s',
      stop: { label: 'Stop', actionToken: 'stop-token-1' },
      items: [{ id: '1', title: 'First', status: 'pending' }],
    });
    await channel.renderAgentTodo('dc:channel-1', {
      headline: 'Done',
      status: 'done',
      elapsed: '2m 20s',
      stop: { label: 'Stop', actionToken: 'stale-stop-token' },
      items: [{ id: '1', title: 'First', status: 'completed' }],
    });

    const posted = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(posted.content).toContain('⏳ Searching the web · 2m 14s');
    expect(JSON.stringify(posted.components)).toContain('stop-token-1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://discord.com/api/v10/channels/channel-1/messages/todo-1',
    );
    const updated = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(updated.content).toContain('✅ Done · 2m 20s');
    expect(updated.components).toEqual([]);
  });

  it('omits broken Stop buttons on threaded todo messages', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'todo-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.renderAgentTodo('dc:channel-1', {
      headline: 'Searching the web',
      status: 'running',
      threadId: 'thread-1',
      stop: { label: 'Stop', actionToken: 'stop-token-1' },
      items: [{ id: '1', title: 'First', status: 'pending' }],
    });

    const posted = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(posted.components).toEqual([]);
    fetchMock.mockRestore();
  });

  it('splits long Discord messages and attaches buttons only to the final chunk', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'message-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'message-2' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.sendMessage('dc:channel-1', 'x'.repeat(2001), {
        actionAffordances: [
          { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
        ],
      }),
    ).resolves.toMatchObject({
      externalMessageIds: ['message-1', 'message-2'],
      deliveredParts: 2,
      totalParts: 2,
      warnings: ['discord.message.chunked:2'],
    });

    const firstBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body || '{}'),
    );
    const secondBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body || '{}'),
    );
    expect(firstBody.content).toHaveLength(2000);
    expect(firstBody.components).toBeUndefined();
    expect(secondBody.content).toHaveLength(1);
    expect(secondBody.components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4,
            label: 'Stop',
            custom_id: 'gantry:live_stop:token-1',
          },
        ],
      },
    ]);
    fetchMock.mockRestore();
  });

  it('marks long Discord message failures after an earlier chunk as partial delivery', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'message-1' }))
      .mockRejectedValueOnce(new Error('discord down'));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.sendMessage('dc:channel-1', `${'a'.repeat(2000)}tail`),
    ).rejects.toMatchObject({
      partialMessageDelivery: true,
      provider: 'discord',
      deliveredParts: 1,
      totalParts: 2,
      externalMessageIds: ['message-1'],
      retryTail: {
        canonicalText: 'tail',
        providerPayload: {
          provider: 'discord',
          channelId: 'channel-1',
        },
      },
    });
    fetchMock.mockRestore();
  });

  it('edits the active Discord progress message instead of posting each update', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'progress-1' }))
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.sendProgressUpdate('dc:channel-1', 'Working', {
      generation: 1,
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });
    await channel.sendProgressUpdate('dc:channel-1', 'Still working', {
      generation: 1,
      replaceOnly: true,
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });
    await channel.sendProgressUpdate('dc:channel-1', 'Done', {
      generation: 1,
      done: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/v10/channels/channel-1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/v10/channels/channel-1/messages/progress-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const doneBody = JSON.parse(
      String(fetchMock.mock.calls[2]?.[1]?.body || '{}'),
    );
    expect(doneBody).toMatchObject({ content: 'Done', components: [] });
    fetchMock.mockRestore();
  });

  it('settles the Discord Stop progress message across generation rollover', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'progress-1' }))
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.sendProgressUpdate('dc:channel-1', '', {
      generation: 1,
      actionOnly: true,
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });
    await channel.sendProgressUpdate('dc:channel-1', 'Done', {
      generation: 2,
      done: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/v10/channels/channel-1/messages/progress-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const doneBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body || '{}'),
    );
    expect(doneBody).toMatchObject({ content: 'Done', components: [] });
    fetchMock.mockRestore();
  });

  it('clears stale Discord progress buttons before replacing with long chunks', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'progress-1' }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'progress-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'progress-3' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await channel.sendProgressUpdate('dc:channel-1', 'Working', {
      generation: 1,
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });
    await channel.sendProgressUpdate('dc:channel-1', `${'a'.repeat(2000)}b`, {
      generation: 1,
      replaceOnly: true,
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/v10/channels/channel-1/messages/progress-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const clearBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body || '{}'),
    );
    expect(clearBody).toMatchObject({
      content: 'Continued below.',
      components: [],
    });
    fetchMock.mockRestore();
  });

  it('streams Discord output by editing one active message at the provider interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'stream-1' }))
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    try {
      await channel.sendStreamingChunk('dc:channel-1', 'Hello');
      await channel.sendStreamingChunk('dc:channel-1', ' world');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1200);
      await channel.sendStreamingChunk('dc:channel-1', '!');
      await channel.sendStreamingChunk('dc:channel-1', '', { done: true });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://discord.com/api/v10/channels/channel-1/messages',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://discord.com/api/v10/channels/channel-1/messages/stream-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
      const finalBody = JSON.parse(
        String(fetchMock.mock.calls[2]?.[1]?.body || '{}'),
      );
      expect(finalBody).toEqual(
        expect.objectContaining({
          content: 'Hello world!',
          components: [],
        }),
      );
    } finally {
      vi.useRealTimers();
      fetchMock.mockRestore();
    }
  });

  it('drops stale Discord streaming chunks after reset seals the generation', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ id: 'stream-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.sendStreamingChunk('dc:channel-1', 'old', { generation: 1 }),
    ).resolves.toBe(true);
    channel.resetStreaming('dc:channel-1');
    await expect(
      channel.sendStreamingChunk('dc:channel-1', 'stale', { generation: 1 }),
    ).resolves.toBe(false);
    await expect(
      channel.sendStreamingChunk('dc:channel-1', 'new', { generation: 2 }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)),
    );
    expect(bodies.map((body) => body.content)).toEqual(['old', 'new']);
    fetchMock.mockRestore();
  });

  it('resets only the targeted Discord thread stream', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'stream-a' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'stream-b' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'stream-a-2' }))
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    try {
      await channel.sendStreamingChunk('dc:channel-1', 'A', {
        threadId: 'thread-a',
      });
      await channel.sendStreamingChunk('dc:channel-1', 'B', {
        threadId: 'thread-b',
      });

      channel.resetStreaming('dc:channel-1', { threadId: 'thread-a' });
      await vi.advanceTimersByTimeAsync(1200);
      await channel.sendStreamingChunk('dc:channel-1', 'A2', {
        threadId: 'thread-a',
      });
      await channel.sendStreamingChunk('dc:channel-1', 'B2', {
        threadId: 'thread-b',
      });

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'https://discord.com/api/v10/channels/thread-a/messages',
        'https://discord.com/api/v10/channels/thread-b/messages',
        'https://discord.com/api/v10/channels/thread-a/messages',
        'https://discord.com/api/v10/channels/thread-b/messages/stream-b',
      ]);
    } finally {
      vi.useRealTimers();
      fetchMock.mockRestore();
    }
  });

  it('does not restore a targeted Discord stream after an in-flight send', async () => {
    let resolveFirstSend!: (response: Response) => void;
    const firstSend = new Promise<Response>((resolve) => {
      resolveFirstSend = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => firstSend)
      .mockImplementation(async () => jsonResponse({ id: 'stream-new' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    const inFlight = channel.sendStreamingChunk('dc:channel-1', 'old', {
      threadId: 'thread-a',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    channel.resetStreaming('dc:channel-1', { threadId: 'thread-a' });
    resolveFirstSend(jsonResponse({ id: 'stream-old' }));
    await inFlight;

    await channel.sendStreamingChunk('dc:channel-1', 'new', {
      threadId: 'thread-a',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://discord.com/api/v10/channels/thread-a/messages',
      'https://discord.com/api/v10/channels/thread-a/messages',
    ]);
  });

  it('stops Discord overflow sends when the stream resets between parts', async () => {
    let channel!: DiscordChannel;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        if (fetchMock.mock.calls.length === 2)
          channel.resetStreaming('dc:channel-1');
        return jsonResponse({ id: `stream-${fetchMock.mock.calls.length}` });
      });
    channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.sendStreamingChunk('dc:channel-1', 'a'.repeat(8000), {
        done: true,
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://discord.com/api/v10/channels/channel-1/messages',
      'https://discord.com/api/v10/channels/channel-1/messages',
    ]);
  });

  it('reports final Discord streaming overflow failure for retry', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'stream-1' }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.sendStreamingChunk('dc:channel-1', `${'a'.repeat(2000)}b`),
    ).resolves.toBe(true);
    await expect(
      channel.sendStreamingChunk('dc:channel-1', '', { done: true }),
    ).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockRestore();
  });

  it('retries Discord REST calls after rate-limit headers', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 429,
          headers: { 'x-ratelimit-reset-after': '0.001' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    try {
      const sendPromise = channel.sendMessage('dc:channel-1', 'Working');
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);

      await expect(sendPromise).resolves.toMatchObject({
        externalMessageId: 'message-1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      fetchMock.mockRestore();
    }
  });

  it('identifies on gateway hello and routes message create events', async () => {
    let socket!: FakeWebSocket;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ url: 'wss://gateway.discord.test' }),
    );
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ onMessage, onChatMetadata }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    socket.receive({ op: 0, t: 'READY', s: 1, d: { user: { id: 'bot-1' } } });
    socket.receive({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'message-2',
        channel_id: 'channel-1',
        content: 'hello',
        timestamp: '2026-06-22T00:00:00.000Z',
        author: { id: 'user-1', username: 'Ravi' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(socket.sent[1] || '{}')).toMatchObject({
      op: 2,
      d: {
        token: 'bot-token',
        intents: 37377,
      },
    });
    expect(onChatMetadata).toHaveBeenCalledWith(
      'dc:channel-1',
      '2026-06-22T00:00:00.000Z',
      undefined,
      'discord',
      true,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'dc:channel-1',
      expect.objectContaining({
        provider: 'discord',
        sender: 'user-1',
        sender_name: 'Ravi',
        content: 'hello',
      }),
    );
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('routes live Discord attachment-only messages with metadata only', async () => {
    let socket!: FakeWebSocket;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ url: 'wss://gateway.discord.test' }),
    );
    const onMessage = vi.fn();
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ onMessage }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    socket.receive({ op: 0, t: 'READY', s: 1, d: { user: { id: 'bot-1' } } });
    socket.receive({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'message-2',
        channel_id: 'channel-1',
        content: '',
        timestamp: '2026-06-22T00:00:00.000Z',
        author: { id: 'user-1', username: 'Ravi' },
        attachments: [
          {
            id: 'attachment-image',
            filename: 'screen.png',
            content_type: 'image/png',
            size: 4096,
          },
          {
            id: 'attachment-file',
            filename: 'report.pdf',
            content_type: 'application/pdf',
            size: 8192,
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onMessage).toHaveBeenCalledWith(
      'dc:channel-1',
      expect.objectContaining({
        content: '',
        attachments: [
          {
            id: 'discord-attachment:attachment-image',
            kind: 'image',
            contentType: 'image/png',
            sizeBytes: 4096,
            externalId: 'attachment-image',
          },
          {
            id: 'discord-attachment:attachment-file',
            kind: 'file',
            contentType: 'application/pdf',
            sizeBytes: 8192,
            externalId: 'attachment-file',
          },
        ],
      }),
    );
    const delivered = onMessage.mock.calls[0]?.[1];
    expect(delivered.attachments[0]).not.toHaveProperty('filename');
    expect(delivered.attachments[0]).not.toHaveProperty('url');
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('normalizes Discord thread channel events to the parent conversation', async () => {
    let socket!: FakeWebSocket;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === 'https://discord.com/api/v10/gateway/bot') {
          return jsonResponse({ url: 'wss://gateway.discord.test' });
        }
        if (url === 'https://discord.com/api/v10/channels/thread-1') {
          return jsonResponse({
            id: 'thread-1',
            type: 11,
            parent_id: 'parent-1',
          });
        }
        if (
          url ===
          'https://discord.com/api/v10/channels/thread-1/messages/message-2/reactions/%F0%9F%91%80/@me'
        ) {
          return jsonResponse({});
        }
        return new Response('{}', { status: 404 });
      });
    let channel!: DiscordChannel;
    const onMessage = vi.fn(
      async (
        jid: string,
        message: { external_message_id?: string; id: string },
      ) => {
        await channel.addReaction(
          jid,
          message.external_message_id || message.id,
          'seen',
        );
      },
    );
    const onChatMetadata = vi.fn();
    channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ onMessage, onChatMetadata }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    socket.receive({ op: 0, t: 'READY', s: 1, d: { user: { id: 'bot-1' } } });
    socket.receive({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'message-2',
        channel_id: 'thread-1',
        content: 'thread reply',
        timestamp: '2026-06-22T00:00:00.000Z',
        author: { id: 'user-1', username: 'Ravi' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onChatMetadata).toHaveBeenCalledWith(
      'dc:parent-1',
      '2026-06-22T00:00:00.000Z',
      undefined,
      'discord',
      true,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'dc:parent-1',
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        thread_id: 'thread-1',
        external_message_id: 'message-2',
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1/messages/message-2/reactions/%F0%9F%91%80/@me',
      expect.objectContaining({ method: 'PUT' }),
    );
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('expires Discord thread message channel ids used for reactions', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    let socket!: FakeWebSocket;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === 'https://discord.com/api/v10/gateway/bot') {
          return jsonResponse({ url: 'wss://gateway.discord.test' });
        }
        if (url === 'https://discord.com/api/v10/channels/thread-1') {
          return jsonResponse({
            id: 'thread-1',
            type: 11,
            parent_id: 'parent-1',
          });
        }
        if (
          url ===
          'https://discord.com/api/v10/channels/parent-1/messages/message-2/reactions/%F0%9F%91%80/@me'
        ) {
          return jsonResponse({});
        }
        return new Response('{}', { status: 404 });
      });
    const channel = new DiscordChannel('bot-token', 'app-id', opts(), (url) => {
      socket = new FakeWebSocket(url);
      return socket;
    });

    await channel.connect();
    socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    socket.receive({ op: 0, t: 'READY', s: 1, d: { user: { id: 'bot-1' } } });
    socket.receive({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'message-2',
        channel_id: 'thread-1',
        content: 'thread reply',
        timestamp: '2026-06-22T00:00:00.000Z',
        author: { id: 'user-1', username: 'Ravi' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    nowSpy.mockReturnValue(11 * 60 * 1000);
    await channel.addReaction('dc:parent-1', 'message-2', 'seen');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/parent-1/messages/message-2/reactions/%F0%9F%91%80/@me',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1/messages/message-2/reactions/%F0%9F%91%80/@me',
      expect.anything(),
    );
    await channel.disconnect();
  });

  it('hydrates Discord attachment-only messages with provider metadata only', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (
          url ===
          'https://discord.com/api/v10/channels/channel-1/messages?limit=3&before=message-4'
        ) {
          return jsonResponse([
            {
              id: 'message-3',
              channel_id: 'channel-1',
              content: '',
              timestamp: '2026-06-22T00:00:03.000Z',
              author: { id: 'user-2', username: 'Maya' },
              attachments: [
                {
                  id: 'att-image',
                  filename: 'screen.png',
                  content_type: 'image/png',
                  size: 4096,
                },
              ],
            },
            {
              id: 'message-2',
              channel_id: 'channel-1',
              content: 'report attached',
              timestamp: '2026-06-22T00:00:02.000Z',
              author: { id: 'user-1', username: 'Ravi' },
              attachments: [
                {
                  id: 'att-file',
                  filename: 'report.pdf',
                  content_type: 'application/pdf',
                  size: 8192,
                },
              ],
            },
            {
              id: 'message-1',
              channel_id: 'channel-1',
              content: '',
              timestamp: '2026-06-22T00:00:01.000Z',
              author: { id: 'user-3', username: 'Isha' },
            },
          ]);
        }
        if (url === 'https://discord.com/api/v10/channels/channel-1') {
          return jsonResponse({ id: 'channel-1', type: 0 });
        }
        return new Response('{}', { status: 404 });
      });
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    const result = await channel.hydrateConversationContext({
      conversationJid: 'dc:channel-1',
      latestMessage: {
        id: 'current',
        timestamp: '2026-06-22T00:00:04.000Z',
        external_message_id: 'message-4',
      },
      limits: { channelMessages: 3, threadMessages: 50 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.messages).toEqual([
      expect.objectContaining({
        external_message_id: 'message-2',
        content: 'report attached',
        attachments: [
          expect.objectContaining({
            kind: 'file',
            contentType: 'application/pdf',
            sizeBytes: 8192,
            externalId: 'att-file',
          }),
        ],
      }),
      expect.objectContaining({
        external_message_id: 'message-3',
        content: '',
        attachments: [
          expect.objectContaining({
            kind: 'image',
            contentType: 'image/png',
            sizeBytes: 4096,
            externalId: 'att-image',
          }),
        ],
      }),
    ]);
    fetchMock.mockRestore();
  });

  it('only marks configured Discord self bot history as bot messages', async () => {
    let socket!: FakeWebSocket;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === 'https://discord.com/api/v10/gateway/bot') {
          return jsonResponse({ url: 'wss://gateway.discord.test' });
        }
        if (
          url ===
          'https://discord.com/api/v10/channels/channel-1/messages?limit=2&before=message-3'
        ) {
          return jsonResponse([
            {
              id: 'message-2',
              channel_id: 'channel-1',
              content: 'Gantry summary',
              timestamp: '2026-06-22T00:00:02.000Z',
              author: { id: 'bot-1', username: 'Gantry', bot: true },
            },
            {
              id: 'message-1',
              channel_id: 'channel-1',
              content: 'deploy finished',
              timestamp: '2026-06-22T00:00:01.000Z',
              author: { id: 'bot-2', username: 'BuildBot', bot: true },
            },
          ]);
        }
        if (url === 'https://discord.com/api/v10/channels/channel-1') {
          return jsonResponse({ id: 'channel-1', type: 0 });
        }
        return new Response('{}', { status: 404 });
      });
    const channel = new DiscordChannel('bot-token', 'app-id', opts(), (url) => {
      socket = new FakeWebSocket(url);
      return socket;
    });
    await channel.connect();
    socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    socket.receive({ op: 0, t: 'READY', s: 1, d: { user: { id: 'bot-1' } } });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'dc:channel-1',
      latestMessage: {
        id: 'current',
        timestamp: '2026-06-22T00:00:03.000Z',
        external_message_id: 'message-3',
      },
      limits: { channelMessages: 2, threadMessages: 50 },
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        sender: 'bot-2',
        content: 'deploy finished',
        is_from_me: false,
        is_bot_message: false,
      }),
      expect.objectContaining({
        sender: 'bot-1',
        content: 'Gantry summary',
        is_from_me: true,
        is_bot_message: true,
        delivery_status: 'sent',
      }),
    ]);
    await channel.disconnect();
    fetchMock.mockRestore();
  });

  it('hydrates Discord thread messages through REST and keeps parent conversation ids', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'message-2',
            channel_id: 'thread-1',
            content: 'second',
            timestamp: '2026-06-22T00:00:02.000Z',
            author: { id: 'user-2', username: 'Maya' },
            referenced_message: {
              id: 'message-1',
              content: 'first',
              author: { id: 'user-1', username: 'Ravi' },
            },
          },
          {
            id: 'message-1',
            channel_id: 'thread-1',
            content: 'first',
            timestamp: '2026-06-22T00:00:01.000Z',
            author: { id: 'user-1', username: 'Ravi' },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'thread-1',
          channel_id: 'thread-1',
          content: 'thread root',
          timestamp: '2026-06-22T00:00:00.000Z',
          author: { id: 'user-root', username: 'Root' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'thread-1', type: 11, parent_id: 'parent-1' }),
      );
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    const result = await channel.hydrateConversationContext({
      conversationJid: 'dc:parent-1',
      threadId: 'thread-1',
      latestMessage: {
        id: 'current',
        timestamp: '2026-06-22T00:00:03.000Z',
        external_message_id: 'message-3',
        thread_id: 'thread-1',
      },
      limits: { channelMessages: 30, threadMessages: 3 },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/v10/channels/thread-1/messages?limit=3&before=message-3',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.messages).toEqual([
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        external_message_id: 'thread-1',
        thread_id: 'thread-1',
      }),
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        external_message_id: 'message-1',
        thread_id: 'thread-1',
      }),
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        external_message_id: 'message-2',
        thread_id: 'thread-1',
        reply_to_message_id: 'message-1',
      }),
    ]);
    fetchMock.mockRestore();
  });

  it('hydrates a Discord thread root message when the latest page does not include it', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (
          url ===
          'https://discord.com/api/v10/channels/thread-1/messages?limit=3&before=message-10'
        ) {
          return jsonResponse([
            {
              id: 'message-9',
              channel_id: 'thread-1',
              content: 'latest',
              timestamp: '2026-06-22T00:00:09.000Z',
              author: { id: 'user-2', username: 'Maya' },
            },
            {
              id: 'message-8',
              channel_id: 'thread-1',
              content: 'recent',
              timestamp: '2026-06-22T00:00:08.000Z',
              author: { id: 'user-3', username: 'Isha' },
            },
            {
              id: 'message-7',
              channel_id: 'thread-1',
              content: 'older but not root',
              timestamp: '2026-06-22T00:00:07.000Z',
              author: { id: 'user-4', username: 'Dev' },
            },
          ]);
        }
        if (
          url ===
          'https://discord.com/api/v10/channels/thread-1/messages/thread-1'
        ) {
          return jsonResponse({
            id: 'thread-1',
            channel_id: 'thread-1',
            content: 'thread starter',
            timestamp: '2026-06-22T00:00:01.000Z',
            author: { id: 'user-1', username: 'Ravi' },
          });
        }
        if (url === 'https://discord.com/api/v10/channels/thread-1') {
          return jsonResponse({
            id: 'thread-1',
            type: 11,
            parent_id: 'parent-1',
          });
        }
        return new Response('{}', { status: 404 });
      });
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    const result = await channel.hydrateConversationContext({
      conversationJid: 'dc:parent-1',
      threadId: 'thread-1',
      latestMessage: {
        id: 'current',
        timestamp: '2026-06-22T00:00:10.000Z',
        external_message_id: 'message-10',
        thread_id: 'thread-1',
      },
      limits: { channelMessages: 30, threadMessages: 3 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1/messages/thread-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(
      result.messages?.map((message) => message.external_message_id),
    ).toEqual(['thread-1', 'message-8', 'message-9']);
    expect(result.messages).toEqual([
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        external_message_id: 'thread-1',
        thread_id: 'thread-1',
      }),
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        external_message_id: 'message-8',
        thread_id: 'thread-1',
      }),
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        external_message_id: 'message-9',
        thread_id: 'thread-1',
      }),
    ]);
    fetchMock.mockRestore();
  });

  it('hydrates first Discord thread replies when the latest page does not include them', async () => {
    const discordMessage = (id: string, content: string, seconds: number) => ({
      id,
      channel_id: 'thread-1',
      content,
      timestamp: `2026-06-22T00:00:${String(seconds).padStart(2, '0')}.000Z`,
      author: { id: `user-${id}`, username: `User ${id}` },
    });
    const firstReplies = Array.from({ length: 10 }, (_, index) =>
      discordMessage(`message-${index + 2}`, `first ${index + 1}`, index + 2),
    );
    const latestReplies = Array.from({ length: 39 }, (_, index) =>
      discordMessage(
        `message-${index + 61}`,
        `latest ${index + 1}`,
        index + 21,
      ),
    ).reverse();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (
          url ===
          'https://discord.com/api/v10/channels/thread-1/messages?limit=39&before=message-100'
        ) {
          return jsonResponse(latestReplies);
        }
        if (
          url ===
          'https://discord.com/api/v10/channels/thread-1/messages/thread-1'
        ) {
          return jsonResponse({
            id: 'thread-1',
            channel_id: 'thread-1',
            content: 'thread starter',
            timestamp: '2026-06-22T00:00:01.000Z',
            author: { id: 'user-1', username: 'Ravi' },
          });
        }
        if (
          url ===
          'https://discord.com/api/v10/channels/thread-1/messages?after=thread-1&limit=10'
        ) {
          return jsonResponse(firstReplies);
        }
        if (url === 'https://discord.com/api/v10/channels/thread-1') {
          return jsonResponse({
            id: 'thread-1',
            type: 11,
            parent_id: 'parent-1',
          });
        }
        return new Response('{}', { status: 404 });
      });
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    const result = await channel.hydrateConversationContext({
      conversationJid: 'dc:parent-1',
      threadId: 'thread-1',
      latestMessage: {
        id: 'current',
        timestamp: '2026-06-22T00:01:40.000Z',
        external_message_id: 'message-100',
        thread_id: 'thread-1',
      },
      limits: { channelMessages: 30, threadMessages: 50 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1/messages/thread-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1/messages?after=thread-1&limit=10',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1/messages?limit=39&before=message-100',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.messages).toHaveLength(50);
    expect(
      result.messages?.map((message) => message.external_message_id),
    ).toEqual([
      'thread-1',
      ...firstReplies.map((message) => message.id),
      ...latestReplies
        .map((message) => message.id)
        .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))),
    ]);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chat_jid: 'dc:parent-1',
          external_message_id: 'thread-1',
          thread_id: 'thread-1',
        }),
        expect.objectContaining({
          chat_jid: 'dc:parent-1',
          external_message_id: 'message-2',
          thread_id: 'thread-1',
        }),
        expect.objectContaining({
          chat_jid: 'dc:parent-1',
          external_message_id: 'message-99',
          thread_id: 'thread-1',
        }),
      ]),
    );
    fetchMock.mockRestore();
  });

  it('hydrates Discord thread replies when root fetch fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (
          url ===
          'https://discord.com/api/v10/channels/thread-1/messages?limit=2&before=message-3'
        ) {
          return jsonResponse([
            {
              id: 'message-2',
              channel_id: 'thread-1',
              content: 'second',
              timestamp: '2026-06-22T00:00:02.000Z',
              author: { id: 'user-2', username: 'Maya' },
            },
          ]);
        }
        if (
          url ===
          'https://discord.com/api/v10/channels/thread-1/messages/thread-1'
        ) {
          return new Response('{}', { status: 404 });
        }
        if (url === 'https://discord.com/api/v10/channels/thread-1') {
          return jsonResponse({
            id: 'thread-1',
            type: 11,
            parent_id: 'parent-1',
          });
        }
        return new Response('{}', { status: 404 });
      });
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    const result = await channel.hydrateConversationContext({
      conversationJid: 'dc:parent-1',
      threadId: 'thread-1',
      latestMessage: {
        id: 'current',
        timestamp: '2026-06-22T00:00:03.000Z',
        external_message_id: 'message-3',
        thread_id: 'thread-1',
      },
      limits: { channelMessages: 30, threadMessages: 2 },
    });

    expect(result.attempted).toBe(true);
    expect(result.failed).toBeUndefined();
    expect(result.messages).toEqual([
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        external_message_id: 'message-2',
        thread_id: 'thread-1',
      }),
    ]);
    fetchMock.mockRestore();
  });

  it('hydrates Discord thread messages against the requested parent when thread lookup fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'message-2',
            channel_id: 'thread-1',
            content: 'second',
            timestamp: '2026-06-22T00:00:02.000Z',
            author: { id: 'user-2', username: 'Maya' },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'thread-1',
          channel_id: 'thread-1',
          content: 'thread root',
          timestamp: '2026-06-22T00:00:00.000Z',
          author: { id: 'user-root', username: 'Root' },
        }),
      )
      .mockRejectedValueOnce(new Error('temporary lookup failure'))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'message-1',
            channel_id: 'thread-1',
            content: 'first',
            timestamp: '2026-06-22T00:00:01.000Z',
            author: { id: 'user-1', username: 'Ravi' },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'thread-1',
          channel_id: 'thread-1',
          content: 'thread root',
          timestamp: '2026-06-22T00:00:00.000Z',
          author: { id: 'user-root', username: 'Root' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'thread-1', type: 11, parent_id: 'parent-1' }),
      );
    const channel = new DiscordChannel('bot-token', 'app-id', opts());
    const request = {
      conversationJid: 'dc:parent-1',
      threadId: 'thread-1',
      latestMessage: {
        id: 'current',
        timestamp: '2026-06-22T00:00:03.000Z',
        external_message_id: 'message-3',
        thread_id: 'thread-1',
      },
      limits: { channelMessages: 30, threadMessages: 2 },
    };

    const failedLookupResult =
      await channel.hydrateConversationContext(request);
    const retryResult = await channel.hydrateConversationContext(request);

    expect(failedLookupResult.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chat_jid: 'dc:parent-1',
          external_message_id: 'thread-1',
          thread_id: 'thread-1',
        }),
      ]),
    );
    expect(retryResult.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chat_jid: 'dc:parent-1',
          external_message_id: 'thread-1',
          thread_id: 'thread-1',
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      'https://discord.com/api/v10/channels/thread-1',
      expect.objectContaining({ method: 'GET' }),
    );
    fetchMock.mockRestore();
  });

  it('reconnects and resumes after a Discord gateway close', async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ url: 'wss://gateway.discord.test' }),
    );
    const channel = new DiscordChannel('bot-token', 'app-id', opts(), (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    });

    await channel.connect();
    sockets[0]!.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    sockets[0]!.receive({
      op: 0,
      t: 'READY',
      s: 3,
      d: { session_id: 'session-1', user: { id: 'bot-1' } },
    });
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.receive({ op: 10, d: { heartbeat_interval: 60_000 } });

    expect(sockets).toHaveLength(2);
    expect(JSON.parse(sockets[1]!.sent[1] || '{}')).toEqual({
      op: 6,
      d: { token: 'bot-token', session_id: 'session-1', seq: 3 },
    });
    channel.disconnect();
  });

  it('routes /gantry slash interactions and live Stop button interactions', async () => {
    let socket!: FakeWebSocket;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockResolvedValue(jsonResponse({}));
    const onMessage = vi.fn();
    const onMessageAction = vi.fn();
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ onMessage, onMessageAction }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-1',
        token: 'token-1',
        type: 2,
        channel_id: 'channel-1',
        data: {
          name: 'gantry',
          options: [
            {
              name: 'model',
              options: [{ name: 'value', type: 3, value: 'opus' }],
            },
          ],
        },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-2',
        token: 'token-2',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:live_stop:stop-token' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-3',
        token: 'token-3',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:scheduler_run_now:job-1' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onMessage).toHaveBeenCalledWith(
      'dc:channel-1',
      expect.objectContaining({ content: '/gantry model opus' }),
    );
    expect(onMessageAction).toHaveBeenCalledWith({
      kind: 'live_turn_stop',
      conversationJid: 'dc:channel-1',
      userId: 'user-1',
      actionToken: 'stop-token',
    });
    expect(onMessageAction).toHaveBeenCalledWith({
      kind: 'scheduler_run_now',
      conversationJid: 'dc:channel-1',
      userId: 'user-1',
      jobId: 'job-1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/interactions/interaction-2/token-2/callback',
      expect.objectContaining({
        body: JSON.stringify({
          type: 4,
          data: {
            content: 'Checking stop request.',
            flags: 64,
            allowed_mentions: { parse: [] },
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/interactions/interaction-3/token-3/callback',
      expect.objectContaining({
        body: JSON.stringify({
          type: 4,
          data: {
            content: 'Checking retry request.',
            flags: 64,
            allowed_mentions: { parse: [] },
          },
        }),
      }),
    );
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('normalizes /gantry slash interactions in Discord threads to the parent conversation', async () => {
    let socket!: FakeWebSocket;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === 'https://discord.com/api/v10/gateway/bot') {
          return jsonResponse({ url: 'wss://gateway.discord.test' });
        }
        if (url === 'https://discord.com/api/v10/channels/thread-1') {
          return jsonResponse({
            id: 'thread-1',
            type: 11,
            parent_id: 'parent-1',
          });
        }
        return jsonResponse({});
      });
    const onMessage = vi.fn();
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ onMessage }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-1',
        token: 'token-1',
        type: 2,
        channel_id: 'thread-1',
        data: {
          name: 'gantry',
          options: [
            {
              name: 'model',
              options: [{ name: 'value', type: 3, value: 'opus' }],
            },
          ],
        },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(onMessage).toHaveBeenCalledWith(
      'dc:parent-1',
      expect.objectContaining({
        chat_jid: 'dc:parent-1',
        thread_id: 'thread-1',
        content: '/gantry model opus',
      }),
    );
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('normalizes Discord thread component callbacks to the parent conversation', async () => {
    let socket!: FakeWebSocket;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === 'https://discord.com/api/v10/gateway/bot') {
          return jsonResponse({ url: 'wss://gateway.discord.test' });
        }
        if (url === 'https://discord.com/api/v10/channels/thread-1') {
          return jsonResponse({
            id: 'thread-1',
            type: 11,
            parent_id: 'parent-1',
          });
        }
        return jsonResponse({});
      });
    const onMessageAction = vi.fn();
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ onMessageAction }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-1',
        token: 'token-1',
        type: 3,
        channel_id: 'thread-1',
        data: { custom_id: 'gantry:live_stop:stop-token' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(onMessageAction).toHaveBeenCalledWith({
      kind: 'live_turn_stop',
      conversationJid: 'dc:parent-1',
      threadId: 'thread-1',
      userId: 'user-1',
      actionToken: 'stop-token',
    });
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('resolves permission approvals from authorized Discord button clicks', async () => {
    let socket!: FakeWebSocket;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const isControlApproverAllowed = vi.fn(async () => true);
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    const onPromptDelivered = vi.fn();
    const approval = channel.requestPermissionApproval(
      'dc:channel-1',
      {
        requestId: 'permission-1',
        sourceAgentFolder: 'main_agent',
        toolName: 'RunCommand',
        targetJid: 'dc:channel-1',
        approvalContextJid: 'dc:approval-context',
      },
      onPromptDelivered,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onPromptDelivered).toHaveBeenCalledOnce();
    expect(onPromptDelivered).toHaveBeenCalledWith('message-1');
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(([, init]) =>
          String(init?.body).includes(
            `Reply in ${Math.round(PERMISSION_APPROVAL_TIMEOUT_MS / 60_000)}m`,
          ),
        ),
    ).toBe(true);
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-1',
        token: 'token-1',
        type: 3,
        channel_id: 'channel-1',
        data: {
          custom_id: permissionCustomId(
            latestDiscordPermissionAlias(),
            'allow_once',
          ),
        },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });

    await expect(approval).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'user-1',
    });
    expect(isControlApproverAllowed).toHaveBeenCalledWith({
      providerId: 'discord',
      conversationJid: 'dc:approval-context',
      userId: 'user-1',
      sourceAgentFolder: 'main_agent',
      decisionPolicy: 'same_channel',
    });
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('resolves a local approval on disconnect when its durable cancel claim is retryable', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    durabilityMocks.claimPermissionInteractionCallback.mockResolvedValue({
      status: 'retryable',
    });
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );

    await channel.connect();
    const approval = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'permission-disconnect-retryable',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      targetJid: 'dc:channel-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await channel.disconnect();

    await expect(approval).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'channel disconnected',
    });
  });

  it('resolves an ownerless Discord permission waiter on disconnect', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    durabilityMocks.claimPermissionInteractionCallback.mockResolvedValue({
      status: 'already_decided',
      ownerless: true,
    });
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );

    await channel.connect();
    const approval = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'permission-disconnect-ownerless',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      targetJid: 'dc:channel-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await channel.disconnect();

    await expect(approval).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'channel disconnected',
    });
    expect((channel as any).interactions.pendingPermissions.size).toBe(0);
  });

  it('preserves a Discord permission waiter owned by an in-flight winner on disconnect', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    durabilityMocks.claimPermissionInteractionCallback.mockResolvedValue({
      status: 'already_decided',
    });
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );
    await channel.connect();
    const approval = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'permission-disconnect-winner',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      targetJid: 'dc:channel-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let resolved = false;
    void approval.then(() => {
      resolved = true;
    });

    await channel.disconnect();
    await Promise.resolve();

    expect(resolved).toBe(false);
    const prompts = (channel as any).interactions.pendingPermissions as Map<
      string,
      any
    >;
    expect(prompts.size).toBe(1);
    const pending = prompts.values().next().value;
    clearTimeout(pending.timeout);
    pending.resolve({ approved: true, mode: 'allow_once', decidedBy: 'owner' });
    prompts.clear();
    await approval;
  });

  it('drops matching Discord permission and question waiters without resolving them', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );
    await channel.connect();
    const permissionRequest = {
      requestId: 'permission-drop-shadow',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      targetJid: 'dc:channel-1',
    };
    const questionRequest = {
      requestId: 'question-drop-shadow',
      sourceAgentFolder: 'main_agent',
      targetJid: 'dc:channel-1',
      questions: [
        {
          question: 'Continue?',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'Continue' }],
        },
      ],
    };
    const approval = channel.requestPermissionApproval(
      'dc:channel-1',
      permissionRequest,
    );
    const answer = channel.requestUserAnswer('dc:channel-1', questionRequest);
    let resolved = 0;
    void approval.then(() => {
      resolved += 1;
    });
    void answer.then(() => {
      resolved += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    channel.dropPendingInteraction('permission', permissionRequest);
    channel.dropPendingInteraction('question', questionRequest);
    await Promise.resolve();

    expect((channel as any).interactions.pendingPermissions.size).toBe(0);
    expect((channel as any).interactions.pendingQuestions.size).toBe(0);
    expect(resolved).toBe(0);
    await channel.disconnect();
  });

  it('preserves partial Discord question answers on disconnect', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );
    await channel.connect();
    const answer = channel.requestUserAnswer('dc:channel-1', {
      requestId: 'question-disconnect-partial',
      sourceAgentFolder: 'main_agent',
      targetJid: 'dc:channel-1',
      questions: [
        {
          question: 'First?',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'Continue' }],
        },
        {
          question: 'Second?',
          multiSelect: false,
          options: [{ label: 'No', description: 'Stop' }],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [
      ...(channel as any).interactions.pendingQuestions.values(),
    ][0];
    pending.answers['First?'] = 'Yes';
    pending.finalizedQuestions.add(0);

    await channel.disconnect();

    await expect(answer).resolves.toEqual({
      requestId: 'question-disconnect-partial',
      answers: { 'First?': 'Yes' },
    });
  });

  it('times out approvals at the shared permission boundary', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );

    await channel.connect();
    const approval = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'permission-shared-timeout',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      targetJid: 'dc:channel-1',
    });
    let settled = false;
    void approval.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(PERMISSION_APPROVAL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(approval).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      reason: 'timed out',
    });
    await channel.disconnect();
  });

  it('resolves the Discord waiter after a no-holder claim exhausts bounded retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    durabilityMocks.claimPermissionInteractionCallback.mockResolvedValue({
      status: 'retryable',
    });
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );

    await channel.connect();
    const approval = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'permission-timeout-retryable',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      targetJid: 'dc:channel-1',
    });
    await vi.advanceTimersByTimeAsync(600_000);

    await expect(approval).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'timed out',
    });
    expect(
      durabilityMocks.claimPermissionInteractionCallback,
    ).toHaveBeenCalledTimes(3);
    expect((channel as any).interactions.pendingPermissions.size).toBe(0);
    await channel.disconnect();
  });

  it('preserves earlier Discord answers when a later question times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );

    await channel.connect();
    const answer = channel.requestUserAnswer('dc:channel-1', {
      requestId: 'question-unrelated-timeout',
      sourceAgentFolder: 'main_agent',
      questions: [
        {
          question: 'First?',
          header: 'First',
          options: [{ label: 'Yes', description: 'Continue' }],
          multiSelect: false,
        },
        {
          question: 'Second?',
          header: 'Second',
          options: [{ label: 'No', description: 'Stop' }],
          multiSelect: false,
        },
      ],
    });
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    durabilityMocks.recordDurableQuestionAnswerProgress.mockImplementation(
      async () => {
        expect(settled).toBe(false);
        return true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    const pending = [
      ...(channel as any).interactions.pendingQuestions.values(),
    ][0];
    pending.answers['First?'] = 'Yes';
    pending.finalizedQuestions.add(0);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(answer).resolves.toEqual({
      requestId: 'question-unrelated-timeout',
      answers: { 'First?': 'Yes', 'Second?': '' },
    });
    expect(
      durabilityMocks.recordDurableQuestionAnswerProgress,
    ).toHaveBeenCalledWith({
      requestId: 'question-unrelated-timeout',
      appId: undefined,
      sourceAgentFolder: 'main_agent',
      answers: { 'Second?': '' },
      completedQuestionIndexes: [1],
    });
    await channel.disconnect();
  });

  it('rejects a Discord timeout when completion cannot be persisted', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    durabilityMocks.recordDurableQuestionAnswerProgress.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts(),
      (url) => new FakeWebSocket(url),
    );

    await channel.connect();
    const answer = channel.requestUserAnswer('dc:channel-1', {
      requestId: 'question-timeout-persistence-failure',
      sourceAgentFolder: 'main_agent',
      questions: [
        {
          question: 'Continue?',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'Continue' }],
        },
      ],
    });
    const rejection = answer.catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await expect(rejection).resolves.toBeInstanceOf(
      durabilityMocks.DurableInteractionPersistenceError,
    );
    expect((channel as any).interactions.pendingQuestions.size).toBe(1);
    await channel.disconnect();
  });

  it('keeps colliding Discord request ids scoped to the authorized agent', async () => {
    let socket!: FakeWebSocket;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed: vi.fn(async () => true) }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );
    await channel.connect();
    const first = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'shared-request',
      sourceAgentFolder: 'agent-a',
      targetJid: 'dc:channel-1',
      toolName: 'RunCommand',
    });
    await vi.waitFor(() =>
      expect(
        durabilityMocks.bindPendingPermissionInteractionMessage,
      ).toHaveBeenCalledTimes(2),
    );
    const firstAlias = latestDiscordPermissionAlias();
    const second = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'shared-request',
      sourceAgentFolder: 'agent-b',
      targetJid: 'dc:channel-1',
      toolName: 'RunCommand',
    });
    await vi.waitFor(() =>
      expect(
        durabilityMocks.bindPendingPermissionInteractionMessage,
      ).toHaveBeenCalledTimes(4),
    );
    const secondAlias = latestDiscordPermissionAlias();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    const click = (providerAlias: string, mode: 'allow_once' | 'cancel') =>
      socket.receive({
        op: 0,
        t: 'INTERACTION_CREATE',
        d: {
          id: `interaction-${providerAlias}`,
          token: `token-${providerAlias}`,
          type: 3,
          channel_id: 'channel-1',
          data: { custom_id: permissionCustomId(providerAlias, mode) },
          member: { user: { id: 'user-1', username: 'Ravi' } },
        },
      });

    click(firstAlias, 'allow_once');
    await expect(first).resolves.toMatchObject({ approved: true });
    expect(secondSettled).toBe(false);
    click(secondAlias, 'cancel');
    await expect(second).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
    });
    await channel.disconnect();
  });

  it('deletes an approved Discord batch prompt before Review each settles', async () => {
    let socket!: FakeWebSocket;
    durabilityMocks.bindPendingPermissionInteractionMessage.mockResolvedValue(
      true,
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-message-1' }))
      .mockResolvedValue(jsonResponse({}));
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed: vi.fn(async () => true) }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );
    const batchRequest = createPermissionBatchRequest(
      [
        {
          requestId: 'permission-1',
          sourceAgentFolder: 'main_agent',
          targetJid: 'dc:channel-1',
          toolName: 'RunCommand',
        },
        {
          requestId: 'permission-2',
          sourceAgentFolder: 'main_agent',
          targetJid: 'dc:channel-1',
          toolName: 'RunCommand',
        },
      ],
      ['1. Command (git status)', '2. Command (git diff)'],
    );

    await channel.connect();
    const approval = channel.requestPermissionApproval(
      'dc:channel-1',
      batchRequest,
    );
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://discord.com/api/v10/channels/channel-1/messages',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-review',
        token: 'token-review',
        type: 3,
        channel_id: 'channel-1',
        data: {
          custom_id: permissionCustomId(
            latestDiscordPermissionAlias(),
            'allow_persistent_rule',
          ),
        },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });

    await expect(approval).resolves.toMatchObject({
      approved: true,
      batchDecision: 'review_each',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages/batch-message-1',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
    await channel.disconnect();
  });

  it('clears a live Discord batch prompt when its post-send binding is already resolved', async () => {
    durabilityMocks.bindPendingPermissionInteractionMessage
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ id: 'batch-message-1' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());
    const batch = createPermissionBatchRequest(
      [
        {
          requestId: 'permission-1',
          sourceAgentFolder: 'main_agent',
          targetJid: 'dc:channel-1',
          toolName: 'RunCommand',
        },
        {
          requestId: 'permission-2',
          sourceAgentFolder: 'main_agent',
          targetJid: 'dc:channel-1',
          toolName: 'RunCommand',
        },
      ],
      ['1. Command', '2. File action'],
    );
    const onPromptDelivered = vi.fn();

    await expect(
      channel.requestPermissionApproval(
        'dc:channel-1',
        batch,
        onPromptDelivered,
      ),
    ).resolves.toMatchObject({ approved: false, mode: 'cancel' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      durabilityMocks.bindPendingPermissionInteractionMessage,
    ).toHaveBeenCalledTimes(2);
    expect(onPromptDelivered).not.toHaveBeenCalled();
    expect((channel as any).interactions.pendingPermissions.size).toBe(0);
  });

  it('propagates a typed Discord post-send binding failure and retains the live waiter', async () => {
    const persistenceError =
      new durabilityMocks.DurableInteractionPersistenceError('binding failed');
    durabilityMocks.bindPendingPermissionInteractionMessage
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(persistenceError);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ id: 'permission-message-1' }),
    );
    const channel = new DiscordChannel('bot-token', 'app-id', opts());

    await expect(
      channel.requestPermissionApproval('dc:channel-1', {
        requestId: 'permission-post-send-persistence-failure',
        sourceAgentFolder: 'main_agent',
        targetJid: 'dc:channel-1',
        toolName: 'RunCommand',
      }),
    ).rejects.toBe(persistenceError);

    expect((channel as any).interactions.pendingPermissions.size).toBe(1);
    await channel.disconnect();
  });

  it('binds chunked Discord prompts to the final message for restart recovery', async () => {
    durabilityMocks.bindPendingPermissionInteractionMessage
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-message-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'batch-message-2' }));
    const channel = new DiscordChannel('bot-token', 'app-id', opts());
    const batch = createPermissionBatchRequest(
      [
        {
          requestId: 'permission-chunked',
          sourceAgentFolder: 'main_agent',
          targetJid: 'dc:channel-1',
          toolName: 'RunCommand',
        },
      ],
      [`1. ${'x'.repeat(2100)}`],
    );

    await expect(
      channel.requestPermissionApproval('dc:channel-1', batch),
    ).resolves.toMatchObject({ approved: false, mode: 'cancel' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      durabilityMocks.bindPendingPermissionInteractionMessage,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({ externalMessageId: 'batch-message-2' }),
    );
  });

  it('replaces an approved Discord prompt before releasing after delete failure', async () => {
    let finishPatch!: () => void;
    const patchResponse = new Promise<Response>((resolve) => {
      finishPatch = () => resolve(jsonResponse({}));
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockImplementationOnce(async () => patchResponse);
    const resolve = vi.fn();
    const decision = { approved: true, mode: 'allow_once' } as const;
    const timeout = setTimeout(() => undefined, 60_000);
    const request = {
      requestId: 'permission-1',
      sourceAgentFolder: 'main_agent',
      targetJid: 'dc:channel-1',
      toolName: 'RunCommand',
      toolInput: { command: 'git status' },
    };
    const pending = pendingDiscordPermissionPrompt(
      discordPermissionCallback(request.requestId),
      request,
      { externalMessageId: 'message-1' },
      'channel-1',
      resolve,
      timeout,
    );
    const pendingPermissions = new Map([
      [pending.callback.providerAlias, pending],
    ]);

    const settlement = settleDiscordPermissionPrompt(
      pendingPermissions,
      pending.callback.providerAlias,
      decision,
      { botToken: 'bot-token' },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/v10/channels/channel-1/messages/message-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          content:
            'Allowed once: Command (git status). The agent will continue this request.',
          components: [],
        }),
      }),
    );
    expect(resolve).not.toHaveBeenCalled();

    finishPatch();
    await expect(settlement).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith(decision);
  });

  it('does not release a Discord decision when delete and fallback update fail', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    const resolve = vi.fn();
    const timeout = setTimeout(() => undefined, 60_000);
    const request = {
      requestId: 'permission-terminalization-failure',
      sourceAgentFolder: 'main_agent',
      targetJid: 'dc:channel-1',
      toolName: 'RunCommand',
    };
    const pending = pendingDiscordPermissionPrompt(
      discordPermissionCallback(request.requestId),
      request,
      { externalMessageId: 'message-1' },
      'channel-1',
      resolve,
      timeout,
    );
    const pendingPermissions = new Map([
      [pending.callback.providerAlias, pending],
    ]);

    await expect(
      settleDiscordPermissionPrompt(
        pendingPermissions,
        pending.callback.providerAlias,
        { approved: true, mode: 'allow_once' },
        { botToken: 'bot-token' },
      ),
    ).resolves.toBe(false);

    expect(resolve).not.toHaveBeenCalled();
    expect(pendingPermissions.get(pending.callback.providerAlias)).toBe(
      pending,
    );
    clearTimeout(timeout);
  });

  it('releases the durable claim after failed settlement so a retry click succeeds', async () => {
    let socket!: FakeWebSocket;
    let deleteAttempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/gateway/bot')) {
        return jsonResponse({ url: 'wss://gateway.discord.test' });
      }
      if (url.endsWith('/channels/channel-1/messages')) {
        return jsonResponse({ id: 'message-1' });
      }
      if (url.includes('/interactions/')) return jsonResponse({});
      if (url.endsWith('/channels/channel-1/messages/message-1')) {
        if (init?.method === 'DELETE') {
          deleteAttempts += 1;
          return new Response('{}', {
            status: deleteAttempts === 1 ? 500 : 200,
          });
        }
        if (init?.method === 'PATCH') {
          return new Response('{}', { status: 500 });
        }
      }
      return jsonResponse({});
    });
    let heldClaim: { id: string; scope: any } | null = null;
    durabilityMocks.claimPermissionInteractionCallback.mockImplementation(
      async (input: any) => {
        if (heldClaim) return { status: 'already_decided' };
        heldClaim = { id: `claim-${deleteAttempts}`, scope: input.scope };
        return { status: 'claimed', claim: heldClaim };
      },
    );
    durabilityMocks.releasePermissionInteractionCallback.mockImplementation(
      async () => {
        heldClaim = null;
        return true;
      },
    );
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed: vi.fn(async () => true) }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    const onPromptDelivered = vi.fn();
    const approval = channel.requestPermissionApproval(
      'dc:channel-1',
      {
        requestId: 'permission-retry',
        sourceAgentFolder: 'main_agent',
        toolName: 'RunCommand',
        targetJid: 'dc:channel-1',
      },
      onPromptDelivered,
    );
    await vi.waitFor(() => expect(onPromptDelivered).toHaveBeenCalledOnce());

    const click = (id: string) =>
      socket.receive({
        op: 0,
        t: 'INTERACTION_CREATE',
        d: {
          id,
          token: `${id}-token`,
          type: 3,
          channel_id: 'channel-1',
          data: {
            custom_id: permissionCustomId(
              latestDiscordPermissionAlias(),
              'allow_once',
            ),
          },
          member: { user: { id: 'user-1', username: 'Ravi' } },
        },
      });

    click('interaction-first');
    await vi.waitFor(() =>
      expect(
        durabilityMocks.releasePermissionInteractionCallback,
      ).toHaveBeenCalledWith({
        claim: expect.objectContaining({
          scope: expect.objectContaining({
            interactionId: 'permission-retry',
          }),
        }),
      }),
    );
    click('interaction-retry');

    await expect(approval).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
    });
    expect(
      durabilityMocks.claimPermissionInteractionCallback,
    ).toHaveBeenCalledTimes(2);
    expect(deleteAttempts).toBe(2);
    await channel.disconnect();
  });

  it('settles the final component-bearing message for chunked batch prompts', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({}));
    const batchRequest = createPermissionBatchRequest(
      [
        {
          requestId: 'permission-1',
          sourceAgentFolder: 'main_agent',
          targetJid: 'dc:channel-1',
          toolName: 'RunCommand',
        },
        {
          requestId: 'permission-2',
          sourceAgentFolder: 'main_agent',
          targetJid: 'dc:channel-1',
          toolName: 'RunCommand',
        },
      ],
      ['1. Command (git status)', '2. Command (git diff)'],
    );
    const timeout = setTimeout(() => undefined, 60_000);
    const pending = pendingDiscordPermissionPrompt(
      discordPermissionCallback(batchRequest.requestId),
      batchRequest,
      {
        externalMessageId: 'batch-message-1',
        externalMessageIds: ['batch-message-1', 'batch-message-2'],
      },
      'channel-1',
      vi.fn(),
      timeout,
    );

    await expect(
      consumeDiscordPermissionPrompt(
        pending,
        { botToken: 'bot-token' },
        { approved: false, mode: 'cancel' },
      ),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages/batch-message-2',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          content: 'Canceled: Review 2 permission requests. Nothing changed.',
          components: [],
        }),
      }),
    );
    clearTimeout(timeout);
  });

  it('edits a timed-out Discord prompt to a minimal receipt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({}));
    const timeout = setTimeout(() => undefined, 60_000);
    const pending = pendingDiscordPermissionPrompt(
      discordPermissionCallback('permission-timeout'),
      {
        requestId: 'permission-timeout',
        sourceAgentFolder: 'main_agent',
        targetJid: 'dc:channel-1',
        toolName: 'RunCommand',
      },
      { externalMessageId: 'message-timeout' },
      'channel-1',
      vi.fn(),
      timeout,
    );

    await consumeDiscordPermissionPrompt(
      pending,
      { botToken: 'bot-token' },
      {
        approved: false,
        mode: 'cancel',
        reason: 'timed out',
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages/message-timeout',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          content: 'Permission request timed out.',
          components: [],
        }),
      }),
    );
    clearTimeout(timeout);
  });

  it('shows Discord full permission payload only in an ephemeral interaction response', async () => {
    let socket!: FakeWebSocket;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const isControlApproverAllowed = vi.fn(async () => true);
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );
    const command = 'npm test -- --runInBand';

    await channel.connect();
    const approval = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'permission-1',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      toolInput: { command },
      targetJid: 'dc:channel-1',
      approvalContextJid: 'dc:approval-context',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const promptCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/channels/channel-1/messages'),
    );
    const promptBody = JSON.parse(
      String((promptCall?.[1] as RequestInit | undefined)?.body),
    ) as {
      content: string;
      components: Array<{
        components: Array<{ label: string; custom_id: string }>;
      }>;
    };
    const providerAlias = latestDiscordPermissionAlias();
    expect(promptBody.content).not.toContain(command);
    expect(promptBody.components.flatMap((row) => row.components)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'View full command',
          custom_id: `gantry:perm_full:${providerAlias}`,
        }),
      ]),
    );

    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-full-view',
        token: 'token-full-view',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: `gantry:perm_full:${providerAlias}` },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fullViewCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes(
        '/interactions/interaction-full-view/token-full-view/callback',
      ),
    );
    expect(fullViewCall).toBeTruthy();
    expect(JSON.parse(String((fullViewCall?.[1] as RequestInit).body))).toEqual(
      {
        type: 4,
        data: {
          content: `Full command\n\`\`\`\n${command}\n\`\`\``,
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      },
    );
    expect(isControlApproverAllowed).toHaveBeenCalledWith({
      providerId: 'discord',
      conversationJid: 'dc:approval-context',
      userId: 'user-1',
      sourceAgentFolder: 'main_agent',
      decisionPolicy: 'same_channel',
    });

    await channel.disconnect();
    await expect(approval).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
    });
    vi.restoreAllMocks();
  });

  it('shows durable Discord full permission payload after channel restart', async () => {
    let socket!: FakeWebSocket;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockResolvedValue(jsonResponse({ id: 'message-1' }));
    durabilityMocks.findDurablePermissionInteractionByRequestId.mockResolvedValue(
      {
        sourceAgentFolder: 'main_agent',
        targetJid: 'dc:channel-1',
        decisionPolicy: 'same_channel',
        fullView: {
          label: 'View full command',
          title: 'Full command',
          filename: 'permission-command.txt',
          content: 'git status --short',
        },
      },
    );
    durabilityMocks.findDurablePermissionInteractionByPromptMessage.mockResolvedValue(
      {
        scope: {
          appId: 'default',
          sourceAgentFolder: 'main_agent',
          interactionId: 'permission-1',
        },
        providerAlias: 'alias-permission-1',
        matchKind: 'individual',
      },
    );
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed: vi.fn(async () => true) }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-full-view',
        token: 'token-full-view',
        type: 3,
        channel_id: 'channel-1',
        message: { id: 'message-1' },
        data: { custom_id: 'gantry:perm_full:alias-permission-1' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fullViewCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes(
        '/interactions/interaction-full-view/token-full-view/callback',
      ),
    );
    expect(fullViewCall).toBeTruthy();
    expect(JSON.parse(String((fullViewCall?.[1] as RequestInit).body))).toEqual(
      {
        type: 4,
        data: {
          content: 'Full command\n```\ngit status --short\n```',
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      },
    );

    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('rejects unknown Discord approval callbacks', () => {
    expect(
      parsePermissionCustomId('gantry:perm:permission-1:unknown_mode'),
    ).toBeNull();
  });

  it('resolves user questions from authorized Discord button clicks', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(
      'question-question-1-0',
    );
    let socket!: FakeWebSocket;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed: vi.fn(async () => true) }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    const onPromptDelivered = vi.fn();
    const answer = channel.requestUserAnswer(
      'dc:channel-1',
      {
        requestId: 'question-1',
        sourceAgentFolder: 'main_agent',
        targetJid: 'dc:channel-1',
        questions: [
          {
            header: 'mode',
            question: 'Choose mode',
            multiSelect: false,
            options: [
              { label: 'Fast', description: 'Use the fast path' },
              { label: 'Careful', description: 'Use the careful path' },
            ],
          },
        ],
      },
      onPromptDelivered,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onPromptDelivered).toHaveBeenCalledWith('message-1', 0);
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-1',
        token: 'token-1',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:q:question-question-1-0:1' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });

    await expect(answer).resolves.toEqual({
      requestId: 'question-1',
      answers: { 'Choose mode': 'Careful' },
      answeredBy: 'user-1',
    });
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('waits for every Discord question before resolving answers', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('question-question-1-0')
      .mockReturnValueOnce('question-question-1-1');
    let socket!: FakeWebSocket;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockImplementation(async () => jsonResponse({ id: 'message-1' }));
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed: vi.fn(async () => true) }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    const answer = channel.requestUserAnswer('dc:channel-1', {
      requestId: 'question-1',
      sourceAgentFolder: 'main_agent',
      targetJid: 'dc:channel-1',
      questions: [
        {
          header: 'mode',
          question: 'Choose mode',
          multiSelect: false,
          options: [{ label: 'Fast', description: 'Use the fast path' }],
        },
        {
          header: 'tone',
          question: 'Choose tone',
          multiSelect: false,
          options: [{ label: 'Direct', description: 'Use direct wording' }],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-1',
        token: 'token-1',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:q:question-question-1-0:0' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-2',
        token: 'token-2',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:q:question-question-1-1:0' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });

    await expect(answer).resolves.toEqual({
      requestId: 'question-1',
      answers: { 'Choose mode': 'Fast', 'Choose tone': 'Direct' },
      answeredBy: 'user-1',
    });
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('resolves Discord multi-select questions only after Done', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(
      'question-question-multi-0',
    );
    let socket!: FakeWebSocket;
    const events: string[] = [];
    const localSelectionsBeforePersistence: Array<string[] | undefined> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://discord.com/api/v10/gateway/bot') {
        return jsonResponse({ url: 'wss://gateway.discord.test' });
      }
      const interactionId = /\/interactions\/(interaction-\d+)\//.exec(
        url,
      )?.[1];
      if (interactionId) events.push(`ack:${interactionId}`);
      return jsonResponse({ id: 'message-1' });
    });
    let channel!: DiscordChannel;
    durabilityMocks.resolveDurableQuestionInteractionByRequestId.mockImplementation(
      async (input: { optionIndex?: number }) => {
        const pending = [
          ...(channel as any).interactions.pendingQuestions.values(),
        ][0];
        localSelectionsBeforePersistence.push(pending.answers['Which checks?']);
        events.push(`persist:${input.optionIndex}`);
        return true;
      },
    );
    channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed: vi.fn(async () => true) }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    const answer = channel.requestUserAnswer('dc:channel-1', {
      requestId: 'question-multi',
      sourceAgentFolder: 'main_agent',
      targetJid: 'dc:channel-1',
      questions: [
        {
          header: 'checks',
          question: 'Which checks?',
          multiSelect: true,
          options: [
            { label: 'Unit', description: 'Run unit tests' },
            { label: 'Typecheck', description: 'Run typecheck' },
          ],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-1',
        token: 'token-1',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:q:question-question-multi-0:0' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-2',
        token: 'token-2',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:q:question-question-multi-0:1' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-3',
        token: 'token-3',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:q:question-question-multi-0:-1' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });

    await expect(answer).resolves.toEqual({
      requestId: 'question-multi',
      answers: { 'Which checks?': ['Unit', 'Typecheck'] },
      answeredBy: 'user-1',
    });
    expect(localSelectionsBeforePersistence).toEqual([undefined, ['Unit']]);
    expect(events.indexOf('persist:0')).toBeLessThan(
      events.indexOf('ack:interaction-1'),
    );
    expect(events.indexOf('persist:1')).toBeLessThan(
      events.indexOf('ack:interaction-2'),
    );
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('routes recovered Discord clicks through application orchestrator transport hooks', async () => {
    let socket!: FakeWebSocket;
    let acked = false;
    const events: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://discord.com/api/v10/gateway/bot') {
        return jsonResponse({ url: 'wss://gateway.discord.test' });
      }
      if (url.includes('/interactions/')) {
        events.push('ack');
        acked = true;
      }
      if (url === 'https://discord.com/api/v10/channels/thread-1') {
        events.push('context');
        return jsonResponse({
          id: 'thread-1',
          type: 11,
          parent_id: 'parent-1',
        });
      }
      return jsonResponse({});
    });
    const durable = {
      requestId: 'batch:permission-1:2',
      batchCallbackId: 'batch:permission-1:2',
      sourceAgentFolder: 'main_agent',
      targetJid: 'dc:parent-1',
      approvalContextJid: 'dc:parent-1',
      threadId: 'thread-1',
      decisionPolicy: 'same_channel',
      decisionOptions: ['allow_persistent_rule', 'cancel'],
      request: {
        requestId: 'permission-1',
        sourceAgentFolder: 'main_agent',
        targetJid: 'dc:parent-1',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
      },
      claim: {
        id: 'review-each-expired',
        scope: {
          appId: 'default',
          sourceAgentFolder: 'main_agent',
          interactionId: 'batch:permission-1:2',
        },
        intent: {
          mode: 'cancel',
          approverRef: 'system',
          decidedAt: '2026-07-19T00:00:00.000Z',
        },
        match: {
          kind: 'batch',
          canonicalId: 'batch:permission-1:2',
          providerAliases: ['alias-batch'],
        },
      },
    } as any;
    durabilityMocks.recoverDurablePermissionDecision.mockImplementation(
      async (hooks: any) => {
        expect(acked).toBe(true);
        events.push('orchestrator');
        expect(hooks.locator).toEqual({
          kind: 'message',
          appId: 'default',
          provider: 'discord',
          conversationId: 'parent-1',
          externalMessageId: 'message-1',
          threadId: 'thread-1',
          providerAlias: 'alias-batch',
        });
        expect(hooks.surfaceJid).toBe('dc:parent-1');
        await expect(hooks.authorize(durable)).resolves.toBe(true);
        await expect(
          hooks.terminalize({
            status: 'resolved',
            request: durable.request,
            context: durable,
            decision: {
              approved: false,
              mode: 'cancel',
              decidedBy: 'system',
              reason: 'canceled',
              permissionCallbackClaim: {
                id: durable.claim.id,
                scope: durable.claim.scope,
              },
            },
          }),
        ).resolves.toBe(true);
        await hooks.feedback('Decision recorded.');
        return 'resolved';
      },
    );
    const isControlApproverAllowed = vi.fn(async () => true);
    const channel = new DiscordChannel(
      'bot-token',
      'app-id',
      opts({ isControlApproverAllowed }),
      (url) => {
        socket = new FakeWebSocket(url);
        return socket;
      },
    );

    await channel.connect();
    socket.receive({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: {
        id: 'interaction-1',
        token: 'token-1',
        type: 3,
        channel_id: 'thread-1',
        message: { id: 'message-1' },
        data: {
          custom_id: permissionCustomId('alias-batch', 'allow_persistent_rule'),
        },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      durabilityMocks.recoverDurablePermissionDecision,
    ).toHaveBeenCalledOnce();
    expect(isControlApproverAllowed).toHaveBeenCalledWith({
      providerId: 'discord',
      conversationJid: 'dc:parent-1',
      threadId: 'thread-1',
      userId: 'user-1',
      sourceAgentFolder: 'main_agent',
      decisionPolicy: 'same_channel',
    });
    expect(events.slice(0, 3)).toEqual(['ack', 'context', 'orchestrator']);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread-1/messages/message-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          content: 'Canceled: exact command access. Nothing changed.',
          components: [],
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://discord.com/api/v10/webhooks/app-id/token-1/messages/@original',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          content: 'Decision recorded.',
          allowed_mentions: { parse: [] },
        }),
      }),
    );
    await channel.disconnect();
    vi.restoreAllMocks();
  });
});
