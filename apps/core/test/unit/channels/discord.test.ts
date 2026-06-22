import { afterEach, describe, expect, it, vi } from 'vitest';

const durabilityMocks = vi.hoisted(() => ({
  findDurablePermissionInteractionByRequestId: vi.fn(),
  findDurableQuestionInteractionByRequestId: vi.fn(),
  resolveDurablePermissionInteractionByRequestId: vi.fn(),
  resolveDurableQuestionInteractionByRequestId: vi.fn(),
}));

vi.mock(
  '@core/application/interactions/pending-interaction-durability.js',
  () => durabilityMocks,
);

import { DiscordChannel } from '@core/channels/discord.js';
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
    durabilityMocks.resolveDurablePermissionInteractionByRequestId.mockReset();
    durabilityMocks.resolveDurableQuestionInteractionByRequestId.mockReset();
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
