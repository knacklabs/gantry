import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../core/config.js', () => ({
  PERMISSION_APPROVAL_TIMEOUT_MS: 300000,
  SLACK_PERMISSION_APPROVER_IDS: new Set<string>(),
}));

vi.mock('../core/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../platform/group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockSlackApp {
    options: any;
    eventHandlers = new Map<string, ((args: any) => Promise<void>)[]>();
    shortcutHandlers = new Map<string, (args: any) => Promise<void>>();
    actionHandlers = new Map<string, (args: any) => Promise<void>>();
    errorHandler: ((err: Error) => Promise<void>) | null = null;

    client = {
      auth: {
        test: vi
          .fn()
          .mockResolvedValue({ ok: true, user_id: 'U_BOT', team: 'My Team' }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          user: { profile: { display_name: 'Alice' } },
        }),
      },
      conversations: {
        info: vi.fn().mockResolvedValue({
          ok: true,
          channel: { id: 'C123', name: 'ops' },
        }),
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: { next_cursor: '' },
        }),
      },
      chat: {
        postMessage: vi
          .fn()
          .mockResolvedValue({ ok: true, ts: '1710000000.100200' }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      },
      apiCall: vi.fn().mockResolvedValue({ ok: false }),
      views: {
        publish: vi.fn().mockResolvedValue({ ok: true }),
        open: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    constructor(options: any) {
      this.options = options;
      appRef.current = this;
    }

    event(name: string, handler: (args: any) => Promise<void>) {
      const list = this.eventHandlers.get(name) || [];
      list.push(handler);
      this.eventHandlers.set(name, list);
    }

    shortcut(name: string, handler: (args: any) => Promise<void>) {
      this.shortcutHandlers.set(name, handler);
    }

    action(name: string, handler: (args: any) => Promise<void>) {
      this.actionHandlers.set(name, handler);
    }

    error(handler: (err: Error) => Promise<void>) {
      this.errorHandler = handler;
    }

    async start() {}

    async stop() {}
  },
}));

import { readEnvFile } from '../core/env.js';
import { SLACK_PERMISSION_APPROVER_IDS } from '../core/config.js';
import { createSlackChannel, SlackChannel } from './slack.js';

function createOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

describe('Slack channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SLACK_PERMISSION_APPROVER_IDS.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createSlackChannel returns null when tokens are missing', () => {
    vi.mocked(readEnvFile).mockReturnValue({});
    const savedBot = process.env.SLACK_BOT_TOKEN;
    const savedApp = process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    try {
      expect(createSlackChannel(createOpts() as any)).toBeNull();
    } finally {
      if (savedBot !== undefined) process.env.SLACK_BOT_TOKEN = savedBot;
      if (savedApp !== undefined) process.env.SLACK_APP_TOKEN = savedApp;
    }
  });

  it('createSlackChannel returns a channel when tokens are available', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      SLACK_BOT_TOKEN: 'xoxb-file-token',
      SLACK_APP_TOKEN: 'xapp-file-token',
    });
    const savedBot = process.env.SLACK_BOT_TOKEN;
    const savedApp = process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    try {
      const channel = createSlackChannel(createOpts() as any);
      expect(channel).toBeInstanceOf(SlackChannel);
    } finally {
      if (savedBot !== undefined) process.env.SLACK_BOT_TOKEN = savedBot;
      if (savedApp !== undefined) process.env.SLACK_APP_TOKEN = savedApp;
    }
  });

  it('sends threaded Slack messages with thread_ts', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    await channel.sendMessage('sl:C1234567890', 'hello', {
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        text: 'hello',
        thread_ts: '1710000000.000111',
      }),
    );
  });

  it('publishes Slack App Home without extra CTA buttons', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('app_home_opened') || [];
    expect(handlers.length).toBeGreaterThan(0);
    await handlers[0]({ event: { user: 'U123' } });

    const publishCall = vi
      .mocked(appRef.current.client.views.publish)
      .mock.calls.at(-1)?.[0];
    const serializedBlocks = JSON.stringify(publishCall?.view?.blocks || []);
    expect(serializedBlocks).not.toContain('Open');
  });

  it('includes Bash command summary in Slack permission prompts', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-cmd',
        sourceGroup: 'slack_main',
        toolName: 'Bash',
        toolInput: {
          command: 'git status --short',
        },
      },
    );

    const postCall = vi
      .mocked(appRef.current.client.chat.postMessage)
      .mock.calls.at(-1)?.[0];
    expect(postCall?.text).toContain('Command: `git status --short`');

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: 'U_APPROVER', name: 'Approver' } },
      action: {
        value: JSON.stringify({ requestId: 'perm-cmd', decision: 'approve' }),
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: true }),
    );
  });

  it('resolves Slack single-select user question from action callback', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-1',
      sourceGroup: 'slack_main',
      questions: [
        {
          header: 'Pick one',
          question: 'Preferred option?',
          options: [
            { label: 'Alpha', description: 'First option' },
            { label: 'Beta', description: 'Second option' },
          ],
          multiSelect: false,
        },
      ],
    });

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_userq_select',
    );
    expect(actionHandler).toBeTypeOf('function');
    const ack = vi.fn().mockResolvedValue(undefined);
    await actionHandler?.({
      ack,
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U123', name: 'Alice' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'userq-1',
          questionIndex: 0,
          optionIndex: 1,
        }),
      },
    });

    const answer = await answerPromise;
    expect(ack).toHaveBeenCalledTimes(1);
    expect(answer.answers).toEqual({ 'Preferred option?': 'Beta' });
    expect(answer.answeredBy).toBe('Alice');
  });

  it('blocks unauthorized Slack user-question answers when approvers are configured', async () => {
    SLACK_PERMISSION_APPROVER_IDS.add('U_APPROVER');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-auth-1',
      sourceGroup: 'slack_main',
      questions: [
        {
          header: 'Pick one',
          question: 'Preferred option?',
          options: [
            { label: 'Alpha', description: 'First option' },
            { label: 'Beta', description: 'Second option' },
          ],
          multiSelect: false,
        },
      ],
    });

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_userq_select',
    );
    expect(actionHandler).toBeTypeOf('function');

    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U_OTHER', name: 'Not Allowed' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'userq-auth-1',
          questionIndex: 0,
          optionIndex: 1,
        }),
      },
    });

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        user: 'U_OTHER',
      }),
    );

    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U_APPROVER', name: 'Allowed' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'userq-auth-1',
          questionIndex: 0,
          optionIndex: 0,
        }),
      },
    });

    const answer = await answerPromise;
    expect(answer.answers).toEqual({ 'Preferred option?': 'Alpha' });
    expect(answer.answeredBy).toBe('Allowed');
  });

  it('resolves Slack multi-select user question after Done action', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-2',
      sourceGroup: 'slack_main',
      questions: [
        {
          header: 'Pick many',
          question: 'Select options',
          options: [
            { label: 'Alpha', description: 'First option' },
            { label: 'Beta', description: 'Second option' },
            { label: 'Gamma', description: 'Third option' },
          ],
          multiSelect: true,
        },
      ],
    });

    const selectHandler = appRef.current.actionHandlers.get(
      'myclaw_userq_select',
    );
    const doneHandler = appRef.current.actionHandlers.get('myclaw_userq_done');
    expect(selectHandler).toBeTypeOf('function');
    expect(doneHandler).toBeTypeOf('function');

    await selectHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U123', name: 'Alice' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'userq-2',
          questionIndex: 0,
          optionIndex: 0,
        }),
      },
    });
    await selectHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U123', name: 'Alice' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'userq-2',
          questionIndex: 0,
          optionIndex: 2,
        }),
      },
    });
    await doneHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U123', name: 'Alice' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'userq-2',
          questionIndex: 0,
        }),
      },
    });

    const answer = await answerPromise;
    expect(answer.answers).toEqual({ 'Select options': ['Alpha', 'Gamma'] });
    expect(answer.answeredBy).toBe('Alice');
  });

  it('returns empty Slack user-question answers when prompt times out', async () => {
    vi.useFakeTimers();
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-timeout',
      sourceGroup: 'slack_main',
      questions: [
        {
          header: 'Timeout',
          question: 'Will timeout',
          options: [
            { label: 'Alpha', description: 'First option' },
            { label: 'Beta', description: 'Second option' },
          ],
          multiSelect: false,
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(300000);
    const answer = await answerPromise;
    expect(answer.answers).toEqual({});
    vi.useRealTimers();
  });

  it('cleans up pending Slack user-question prompts on disconnect', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-disconnect',
      sourceGroup: 'slack_main',
      questions: [
        {
          header: 'Disconnect',
          question: 'Pending question',
          options: [
            { label: 'Alpha', description: 'First option' },
            { label: 'Beta', description: 'Second option' },
          ],
          multiSelect: false,
        },
      ],
    });

    await Promise.resolve();
    await channel.disconnect();
    await expect(answerPromise).resolves.toEqual(
      expect.objectContaining({ answers: {} }),
    );
  });

  it('does not duplicate first chunk when native Slack streaming starts', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream') {
          return { ok: true };
        }
        if (method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );

    await channel.sendStreamingChunk('sl:C1234567890', 'hello');

    const apiCallCalls = vi.mocked(appRef.current.client.apiCall).mock.calls;
    const startCalls = apiCallCalls.filter(
      ([method]: [string]) => method === 'chat.startStream',
    );
    const appendCalls = apiCallCalls.filter(
      ([method]: [string]) => method === 'chat.appendStream',
    );
    expect(startCalls).toHaveLength(1);
    expect(appendCalls).toHaveLength(0);
  });

  it('throttles native Slack stream appends by update interval', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string, payload: Record<string, unknown>) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream') {
          return { ok: true, payload };
        }
        if (method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1200)
      .mockReturnValueOnce(2200);

    await channel.sendStreamingChunk('sl:C1234567890', 'A');
    await channel.sendStreamingChunk('sl:C1234567890', 'B');
    await channel.sendStreamingChunk('sl:C1234567890', 'C');

    const apiCallCalls = vi.mocked(appRef.current.client.apiCall).mock.calls;
    const startCalls = apiCallCalls.filter(
      ([method]: [string]) => method === 'chat.startStream',
    );
    const appendCalls = apiCallCalls.filter(
      ([method]: [string]) => method === 'chat.appendStream',
    );

    expect(startCalls).toHaveLength(1);
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]?.[1]).toEqual(
      expect.objectContaining({ markdown_text: 'BC' }),
    );
  });

  it('falls back to message streaming without duplicating native-rendered prefix', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream') {
          return { ok: false };
        }
        return { ok: false };
      },
    );

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(2200);

    await channel.sendStreamingChunk('sl:C1234567890', 'Hello');
    await channel.sendStreamingChunk('sl:C1234567890', ' world');

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        text: ' world',
      }),
    );
  });

  it('ignores stale streaming generations for the same chat', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream' || method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );

    await channel.sendStreamingChunk('sl:C1234567890', 'fresh', {
      generation: 2,
    });

    const callsBeforeStale = vi.mocked(appRef.current.client.apiCall).mock.calls
      .length;

    await channel.sendStreamingChunk('sl:C1234567890', 'stale', {
      generation: 1,
    });

    expect(vi.mocked(appRef.current.client.apiCall).mock.calls.length).toBe(
      callsBeforeStale,
    );
  });

  it('seals previous generation on resetStreaming to reject late stale chunks', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream' || method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );

    await channel.sendStreamingChunk('sl:C1234567890', 'old', {
      generation: 1,
    });

    channel.resetStreaming('sl:C1234567890');
    await Promise.resolve();
    vi.mocked(appRef.current.client.apiCall).mockClear();

    await channel.sendStreamingChunk('sl:C1234567890', 'stale', {
      generation: 1,
    });

    expect(vi.mocked(appRef.current.client.apiCall)).not.toHaveBeenCalled();

    await channel.sendStreamingChunk('sl:C1234567890', 'fresh', {
      generation: 2,
    });

    expect(vi.mocked(appRef.current.client.apiCall)).toHaveBeenCalledWith(
      'chat.startStream',
      expect.objectContaining({
        channel: 'C1234567890',
        markdown_text: 'fresh',
      }),
    );
  });

  it('resolves permission prompt once even if timeout is reached later', async () => {
    vi.useFakeTimers();
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const decisionPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'req-1',
        sourceGroup: 'test',
        toolName: 'shell',
      },
    );

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_perm_decision',
    );
    expect(actionHandler).toBeTypeOf('function');
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: 'U_APPROVER', name: 'Approver' } },
      action: {
        value: JSON.stringify({ requestId: 'req-1', decision: 'approve' }),
      },
    });

    const decision = await decisionPromise;
    expect(decision).toEqual(
      expect.objectContaining({ approved: true, decidedBy: 'Approver' }),
    );
    expect(appRef.current.client.chat.update).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300000);
    expect(appRef.current.client.chat.update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
