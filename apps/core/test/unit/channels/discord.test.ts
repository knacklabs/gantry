import { afterEach, describe, expect, it, vi } from 'vitest';

const durabilityMocks = vi.hoisted(() => ({
  bindPendingPermissionInteractionMessage: vi.fn(),
  findDurablePermissionInteractionByRequestId: vi.fn(),
  findDurableQuestionInteractionByRequestId: vi.fn(),
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
import type { ChannelOpts } from '@core/channels/channel-provider.js';

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

describe('DiscordChannel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    durabilityMocks.findDurablePermissionInteractionByRequestId.mockReset();
    durabilityMocks.findDurableQuestionInteractionByRequestId.mockReset();
    durabilityMocks.bindPendingPermissionInteractionMessage.mockReset();
    durabilityMocks.resolveDurablePermissionInteractionByRequestId.mockReset();
    durabilityMocks.resolveDurableQuestionInteractionByRequestId.mockReset();
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
          {
            kind: 'scheduler_open',
            label: 'Open in scheduler',
            jobId: 'job-1',
          },
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
    const approval = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'permission-1',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      targetJid: 'dc:channel-1',
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
        data: { custom_id: 'gantry:perm:permission-1:allow_once' },
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
      conversationJid: 'dc:channel-1',
      userId: 'user-1',
      sourceAgentFolder: 'main_agent',
      decisionPolicy: 'same_channel',
    });
    await channel.disconnect();
    vi.restoreAllMocks();
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
    expect(promptBody.content).not.toContain(command);
    expect(promptBody.components.flatMap((row) => row.components)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'View full command',
          custom_id: 'gantry:perm_full:permission-1',
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
        data: { custom_id: 'gantry:perm_full:permission-1' },
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
        data: { custom_id: 'gantry:perm_full:permission-1' },
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

  it('uses shared permission decision semantics for timed Discord approvals', async () => {
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
    const approval = channel.requestPermissionApproval('dc:channel-1', {
      requestId: 'permission-1',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      targetJid: 'dc:channel-1',
      decisionOptions: ['allow_timed_grant', 'cancel'],
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
        data: { custom_id: 'gantry:perm:permission-1:allow_timed_grant' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });

    const decision = await approval;
    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_timed_grant',
      decidedBy: 'user-1',
      decisionClassification: 'user_temporary',
    });
    expect(decision.timedGrantExpiresAtMs).toEqual(expect.any(Number));
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('resolves user questions from authorized Discord button clicks', async () => {
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
          options: [
            { label: 'Fast', description: 'Use the fast path' },
            { label: 'Careful', description: 'Use the careful path' },
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
        data: { custom_id: 'gantry:q:question-1:0:1' },
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
        data: { custom_id: 'gantry:q:question-1:0:0' },
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
        data: { custom_id: 'gantry:q:question-1:1:0' },
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
        data: { custom_id: 'gantry:q:question-multi:0:0' },
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
        data: { custom_id: 'gantry:q:question-multi:0:1' },
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
        data: { custom_id: 'gantry:q:question-multi:0:-1' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });

    await expect(answer).resolves.toEqual({
      requestId: 'question-multi',
      answers: { 'Which checks?': ['Unit', 'Typecheck'] },
      answeredBy: 'user-1',
    });
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('resolves permission buttons through durable state after restart', async () => {
    let socket!: FakeWebSocket;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockResolvedValue(jsonResponse({}));
    durabilityMocks.findDurablePermissionInteractionByRequestId.mockResolvedValue(
      {
        sourceAgentFolder: 'main_agent',
        targetJid: 'dc:channel-1',
        decisionPolicy: 'same_channel',
      },
    );
    durabilityMocks.resolveDurablePermissionInteractionByRequestId.mockResolvedValue(
      true,
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
        id: 'interaction-1',
        token: 'token-1',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:perm:permission-1:allow_once' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      durabilityMocks.resolveDurablePermissionInteractionByRequestId,
    ).toHaveBeenCalledWith({
      requestId: 'permission-1',
      mode: 'allow_once',
      approverRef: 'user-1',
      reason: 'resolved via Discord after channel restart',
    });
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  it('resolves question buttons through durable state after restart', async () => {
    let socket!: FakeWebSocket;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ url: 'wss://gateway.discord.test' }),
      )
      .mockResolvedValue(jsonResponse({}));
    durabilityMocks.findDurableQuestionInteractionByRequestId.mockResolvedValue(
      {
        sourceAgentFolder: 'main_agent',
        targetJid: 'dc:channel-1',
        request: null,
      },
    );
    durabilityMocks.resolveDurableQuestionInteractionByRequestId.mockResolvedValue(
      true,
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
        id: 'interaction-1',
        token: 'token-1',
        type: 3,
        channel_id: 'channel-1',
        data: { custom_id: 'gantry:q:question-1:0:1' },
        member: { user: { id: 'user-1', username: 'Ravi' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      durabilityMocks.resolveDurableQuestionInteractionByRequestId,
    ).toHaveBeenCalledWith({
      requestId: 'question-1',
      questionIndex: 0,
      optionIndex: 1,
      finalize: true,
      answeredBy: 'user-1',
    });
    await channel.disconnect();
    vi.restoreAllMocks();
  });
});
