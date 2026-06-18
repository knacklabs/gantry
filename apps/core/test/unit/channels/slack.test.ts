import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

const defaultSlackPermissionApproverIds = vi.hoisted(() => new Set<string>());
const currentControlAllowlist = vi.hoisted(() => ({
  current: {
    default: [] as string[],
    agents: {} as Record<string, string[]>,
  },
}));

vi.mock('@core/config/index.js', () => ({
  DEFAULT_TRIGGER: '@bot',
  PERMISSION_APPROVAL_TIMEOUT_MS: 300000,
  getSlackBotToken: () => process.env.SLACK_BOT_TOKEN || '',
  getSlackAppToken: () => process.env.SLACK_APP_TOKEN || '',
  getSlackPermissionApproverIds: (sourceAgentFolder?: string) => {
    const allowlist = currentControlAllowlist.current;
    const scoped =
      sourceAgentFolder && allowlist.agents[sourceAgentFolder] !== undefined
        ? allowlist.agents[sourceAgentFolder]
        : allowlist.default;
    return new Set(scoped);
  },
  getTriggerPattern: (trigger?: string) =>
    trigger ? new RegExp(`^${trigger}\\b`, 'i') : /^@bot\b/i,
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: vi.fn(
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
    viewHandlers = new Map<string, (args: any) => Promise<void>>();
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

    view(name: string, handler: (args: any) => Promise<void>) {
      this.viewHandlers.set(name, handler);
    }

    error(handler: (err: Error) => Promise<void>) {
      this.errorHandler = handler;
    }

    async start() {}

    async stop() {}
  },
}));

import { createSlackChannel, SlackChannel } from '@core/channels/slack.js';
import {
  buildPermissionPromptContentBlocks,
  buildPermissionReceiptBlocks,
} from '@core/channels/slack/permission-blocks.js';
import { SLACK_PERMISSION_DECISION_ACTION_IDS } from '@core/channels/slack/permission-action-id.js';

function createOpts(
  controlAllowlist = {
    default: Array.from(defaultSlackPermissionApproverIds),
    agents: {} as Record<string, string[]>,
  },
) {
  currentControlAllowlist.current = controlAllowlist;
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    conversationRoutes: vi.fn(() => ({})),
    runtimeSettings: vi.fn(() => ({
      providers: {
        slack: { enabled: true },
      },
      providerConnections: {
        slack_default: {
          provider: 'slack',
          label: 'Slack',
          runtimeSecretRefs: {},
        },
      },
      conversations: {
        slack_test_conversation: {
          providerConnection: 'slack_default',
          externalId: 'C123',
          kind: 'channel',
          displayName: 'test',
          senderPolicy: { allow: '*', mode: 'trigger' },
          controlApprovers: controlAllowlist.default,
        },
      },
      bindings: {
        slack_test_binding: {
          agent: 'slack_main',
          conversation: 'slack_test_conversation',
          trigger: '@bot',
          addedAt: '2024-01-01T00:00:00.000Z',
          requiresTrigger: true,
          memoryScope: 'conversation',
        },
      },
    })),
  };
}

function createOptsWithApproverHook(
  allowedUsers: readonly string[],
  controlAllowlist = {
    default: Array.from(allowedUsers),
    agents: {} as Record<string, string[]>,
  },
) {
  return {
    ...createOpts(controlAllowlist),
    isControlApproverAllowed: vi.fn(async (input: { userId: string }) =>
      allowedUsers.includes(input.userId),
    ),
  };
}

async function flushSlackPromptRegistration(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Slack channel', () => {
  let savedGantryHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedGantryHome = process.env.GANTRY_HOME;
    delete process.env.GANTRY_HOME;
    defaultSlackPermissionApproverIds.clear();
  });

  afterEach(() => {
    if (savedGantryHome === undefined) delete process.env.GANTRY_HOME;
    else process.env.GANTRY_HOME = savedGantryHome;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('createSlackChannel returns null when tokens are missing', () => {
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
    const savedBot = process.env.SLACK_BOT_TOKEN;
    const savedApp = process.env.SLACK_APP_TOKEN;
    process.env.SLACK_BOT_TOKEN = 'xoxb-file-token';
    process.env.SLACK_APP_TOKEN = 'xapp-file-token';
    try {
      const channel = createSlackChannel(createOpts() as any);
      expect(channel).toBeInstanceOf(SlackChannel);
    } finally {
      if (savedBot !== undefined) process.env.SLACK_BOT_TOKEN = savedBot;
      else delete process.env.SLACK_BOT_TOKEN;
      if (savedApp !== undefined) process.env.SLACK_APP_TOKEN = savedApp;
      else delete process.env.SLACK_APP_TOKEN;
    }
  });

  it('records metadata only for unregistered Slack conversations', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    expect(handlers.length).toBeGreaterThan(0);
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000100',
        user: 'U123',
        text: 'hello',
      },
    });

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'sl:C123',
      expect.any(String),
      'ops',
      'slack',
      true,
    );
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('delivers unregistered Slack DMs to the shared persistence policy', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    await handlers[0]({
      event: {
        channel: 'D123',
        ts: '1710000000.000100',
        user: 'U123',
        text: 'hello',
      },
    });

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'sl:D123',
      expect.any(String),
      'ops',
      'slack',
      false,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:D123',
      expect.objectContaining({
        chat_jid: 'sl:D123',
        provider: 'slack',
        sender: 'U123',
        content: 'hello',
      }),
    );
  });

  it('delivers Slack messages for registered conversations', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      'sl:C123': { folder: 'slack_ops', name: 'Ops' },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    expect(handlers.length).toBeGreaterThan(0);
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000100',
        user: 'U123',
        text: 'hello',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        chat_jid: 'sl:C123',
        sender: 'U123',
        sender_name: 'Alice',
        content: 'hello',
      }),
    );
  });

  it('normalizes top-level Slack channel messages as their own thread root', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      'sl:C123': { folder: 'slack_ops', name: 'Ops' },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('app_mention') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000100',
        user: 'U123',
        text: '<@U_BOT> list projects',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        external_message_id: '1710000000.000100',
        thread_id: '1710000000.000100',
        content: '@Ops list projects',
        reply_to_message_id: undefined,
      }),
    );
  });

  it('normalizes only the authenticated Slack bot mention before command parsing', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      'sl:C123': { folder: 'slack_ops', name: 'Ops', trigger: '@Gantry' },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('app_mention') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000100',
        user: 'U123',
        text: '<@U_BOT> !new',
      },
    });
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000200',
        user: 'U123',
        text: '<@U_OTHER> !new',
      },
    });

    expect(opts.onMessage).toHaveBeenNthCalledWith(
      1,
      'sl:C123',
      expect.objectContaining({ content: '@Gantry !new' }),
    );
    expect(opts.onMessage).toHaveBeenNthCalledWith(
      2,
      'sl:C123',
      expect.objectContaining({ content: '<@U_OTHER> !new' }),
    );
  });

  it('keeps Slack thread replies in the root thread without requiring a new root', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      'sl:C123': { folder: 'slack_ops', name: 'Ops' },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000001.000200',
        thread_ts: '1710000000.000100',
        user: 'U123',
        text: 'continue without tag',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        external_message_id: '1710000001.000200',
        thread_id: '1710000000.000100',
        reply_to_message_id: '1710000000.000100',
      }),
    );
  });

  it('does not synthesize root threads for unrelated top-level channel chatter', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      'sl:C123': {
        folder: 'slack_ops',
        name: 'Ops',
        trigger: '@bot',
        requiresTrigger: true,
      },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000100',
        user: 'U123',
        text: 'hello ops',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        external_message_id: '1710000000.000100',
        thread_id: undefined,
      }),
    );
  });

  it('does not force top-level Slack DMs into threads', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    await handlers[0]({
      event: {
        channel: 'D123',
        ts: '1710000000.000100',
        user: 'U123',
        text: 'hello',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:D123',
      expect.objectContaining({
        external_message_id: '1710000000.000100',
        thread_id: undefined,
      }),
    );
  });

  it('stores Slack attachments without exposing local paths in message content', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      'sl:C123': { folder: 'slack_ops', name: 'Ops' },
    });
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as any);
    vi.spyOn(fs, 'chmodSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        body: null,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      }),
    );
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000100',
        user: 'U123',
        text: 'see file',
        files: [
          {
            id: 'F123',
            name: 'report.pdf',
            mimetype: 'application/pdf',
            url_private_download: 'https://files.slack.test/report.pdf',
          },
        ],
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        content: 'see file\nAttachment: report.pdf',
        attachments: [
          expect.objectContaining({
            externalId: 'F123',
            storageRef: 'attachments/report.pdf',
          }),
        ],
      }),
    );
    expect(opts.onMessage.mock.calls[0][1].content).not.toContain('/tmp/');
    expect(mkdirSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_ops/attachments',
      { recursive: true, mode: 0o700 },
    );
    expect(writeSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_ops/attachments/report.pdf',
      expect.any(Buffer),
      { mode: 0o600 },
    );
  });

  it('resets Slack attachment file mode when overwriting buffered downloads', async () => {
    class TestSlackChannel extends SlackChannel {
      write(response: Response, destPath: string) {
        return this.writeFetchResponseToFile(response, destPath);
      }
    }
    vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isSymbolicLink: () => false,
    } as any);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    const chmodSpy = vi.spyOn(fs, 'chmodSync').mockReturnValue(undefined);
    const channel = new TestSlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );

    await expect(
      channel.write(
        {
          headers: { get: () => null },
          body: null,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as unknown as Response,
        '/tmp/test-groups/slack_ops/attachments/report.pdf',
      ),
    ).resolves.toBe(true);

    expect(writeSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_ops/attachments/report.pdf',
      expect.any(Buffer),
      { mode: 0o600 },
    );
    expect(chmodSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_ops/attachments/report.pdf',
      0o600,
    );
  });

  it('resets Slack attachment file mode when overwriting streamed downloads', async () => {
    class TestSlackChannel extends SlackChannel {
      write(response: Response, destPath: string) {
        return this.writeFetchResponseToFile(response, destPath);
      }
    }
    vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isSymbolicLink: () => false,
    } as any);
    const openSpy = vi.spyOn(fs, 'openSync').mockReturnValue(123);
    const writeSpy = vi.spyOn(fs, 'writeSync').mockReturnValue(2);
    const closeSpy = vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
    const chmodSpy = vi.spyOn(fs, 'chmodSync').mockReturnValue(undefined);
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
        .mockResolvedValueOnce({ done: true }),
    };
    const channel = new TestSlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );

    await expect(
      channel.write(
        {
          headers: { get: () => null },
          body: { getReader: () => reader },
        } as unknown as Response,
        '/tmp/test-groups/slack_ops/attachments/report.pdf',
      ),
    ).resolves.toBe(true);

    expect(openSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_ops/attachments/report.pdf',
      'w',
      0o600,
    );
    expect(writeSpy).toHaveBeenCalledWith(123, expect.any(Buffer));
    expect(closeSpy).toHaveBeenCalledWith(123);
    expect(chmodSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_ops/attachments/report.pdf',
      0o600,
    );
  });

  it('sends threaded Slack messages with thread_ts', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
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

  it('renders Slack todo plans inside their source thread', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const postMessage = vi.mocked(appRef.current.client.chat.postMessage);
    const update = vi.mocked(appRef.current.client.chat.update);
    postMessage.mockClear();
    update.mockClear();
    postMessage
      .mockResolvedValueOnce({ ok: true, ts: '1710000000.100201' })
      .mockResolvedValueOnce({ ok: true, ts: '1710000000.100202' });

    await channel.renderAgentTodo('sl:C1234567890', {
      threadId: '1710000000.000111',
      summary: 'Thread one',
      items: [{ id: 'a', title: 'A', status: 'pending' }],
    });
    await channel.renderAgentTodo('sl:C1234567890', {
      threadId: '1710000000.000222',
      summary: 'Thread two',
      items: [{ id: 'b', title: 'B', status: 'pending' }],
    });
    await channel.renderAgentTodo('sl:C1234567890', {
      threadId: '1710000000.000111',
      summary: 'Thread one updated',
      items: [{ id: 'a', title: 'A', status: 'completed' }],
    });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        channel: 'C1234567890',
        thread_ts: '1710000000.000111',
      }),
    );
    expect(postMessage.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        channel: 'C1234567890',
        thread_ts: '1710000000.000222',
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        ts: '1710000000.100201',
      }),
    );
  });

  it('renders scheduler dead-letter action affordances as Slack buttons', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    await channel.sendMessage('sl:C1234567890', 'Paused after failures', {
      actionAffordances: [
        { kind: 'scheduler_run_now', label: 'Retry now', jobId: 'job-1' },
        { kind: 'scheduler_pause_job', label: 'Pause job', jobId: 'job-1' },
        {
          kind: 'scheduler_open',
          label: 'Open in scheduler',
          jobId: 'job-1',
        },
      ],
    });

    const payload = appRef.current.client.chat.postMessage.mock.calls[0]?.[0];
    expect(
      payload.blocks[1].elements.map((button: any) => button.text.text),
    ).toEqual(['Retry now', 'Pause job', 'Open in scheduler']);
    expect(payload.blocks[1].elements[0]).toEqual(
      expect.objectContaining({
        action_id: 'gantry_message_action',
        value: expect.stringContaining('"kind":"scheduler_run_now"'),
      }),
    );
  });

  it('fails closed when Slack scheduler action buttons are clicked', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_message_action',
    );
    expect(actionHandler).toBeDefined();
    const ack = vi.fn();
    await actionHandler({
      ack,
      action: {
        value: JSON.stringify({
          kind: 'scheduler_run_now',
          jobId: 'job-1',
          runId: 'run-1',
        }),
      },
      body: { channel: { id: 'C1234567890' }, user: { id: 'U_APPROVER' } },
    });

    expect(ack).toHaveBeenCalled();
    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        user: 'U_APPROVER',
      }),
    );
  });

  it('chunks outbound Slack messages to 4000-char parts and returns delivery metadata', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const result = await channel.sendMessage(
      'sl:C1234567890',
      'x'.repeat(4500),
    );

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(appRef.current.client.chat.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: 'C1234567890',
        text: 'x'.repeat(4000),
      }),
    );
    expect(appRef.current.client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: 'C1234567890',
        text: 'x'.repeat(500),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 2,
        totalParts: 2,
        warnings: ['slack.message.chunked:2'],
      }),
    );
  });

  it('marks chunked Slack partial failures with retry-tail metadata for only unsent suffix', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.chat.postMessage)
      .mockResolvedValueOnce({
        ok: true,
        ts: '1710000000.100200',
      } as any)
      .mockRejectedValueOnce(new Error('second chunk failed'));

    await expect(
      channel.sendMessage('sl:C1234567890', 'x'.repeat(4500)),
    ).rejects.toMatchObject({
      name: 'PartialSlackDeliveryError',
      partialMessageDelivery: true,
      deliveredChunks: 1,
      totalChunks: 2,
      retryTail: {
        canonicalText: 'x'.repeat(500),
        providerPayload: expect.objectContaining({
          provider: 'slack',
          channelId: 'C1234567890',
        }),
      },
    });
  });

  it('retries Slack outbound posts on rate limit responses', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.chat.postMessage)
      .mockResolvedValueOnce({
        ok: false,
        error: 'ratelimited',
        retry_after: 0.001,
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        ts: '1710000000.200300',
      } as any);

    const result = await channel.sendMessage('sl:C1234567890', 'hello');

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 1,
        totalParts: 1,
        warnings: ['slack.rate_limited_retry'],
      }),
    );
  });

  it('clamps Slack outbound retry_after waits to a bounded maximum', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.useFakeTimers();

    try {
      vi.mocked(appRef.current.client.chat.postMessage)
        .mockResolvedValueOnce({
          ok: false,
          error: 'ratelimited',
          retry_after: 999_999,
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          ts: '1710000000.200300',
        } as any);

      const sendPromise = channel.sendMessage('sl:C1234567890', 'hello');
      await Promise.resolve();
      expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4999);
      expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await sendPromise;
      expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(result).toEqual(
        expect.objectContaining({
          deliveredParts: 1,
          totalParts: 1,
          warnings: ['slack.rate_limited_retry'],
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the Slack snippet fallback hook for oversized payload failures', async () => {
    class SlackChannelWithSnippetFallback extends SlackChannel {
      protected override async sendSnippetFallback() {
        return {
          fallbackArtifactId: 'slack-artifact-1',
          externalMessageId: '1710000000.400500',
        };
      }
    }

    const channel = new SlackChannelWithSnippetFallback(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.chat.postMessage).mockRejectedValueOnce({
      status: 413,
      message: 'payload too large',
    } as any);

    const result = await channel.sendMessage('sl:C1234567890', 'hello');

    expect(result).toEqual(
      expect.objectContaining({
        deliveredParts: 1,
        fallbackArtifactId: 'slack-artifact-1',
        externalMessageId: '1710000000.400500',
        warnings: ['slack.snippet_fallback'],
      }),
    );
  });

  it('does not create Slack progress for replace-only updates without existing state', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    await channel.sendProgressUpdate('sl:C1234567890', 'Done in 1s.', {
      done: true,
      replaceOnly: true,
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).not.toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      expect.anything(),
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('edits and clears existing Slack progress for replace-only done', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    await channel.sendProgressUpdate('sl:C1234567890', 'Working on it...');
    await channel.sendProgressUpdate('sl:C1234567890', 'Done in 1s.', {
      done: true,
      replaceOnly: true,
    });
    expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
      channel: 'C1234567890',
      ts: '1710000000.100200',
      text: 'Done in 1s.',
    });
    appRef.current.client.chat.postMessage.mockClear();
    appRef.current.client.chat.update.mockClear();

    await channel.sendProgressUpdate('sl:C1234567890', 'Done in 2s.', {
      done: true,
      replaceOnly: true,
    });

    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('edits normal Slack done progress and clears the active handle', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    await channel.sendProgressUpdate('sl:C1234567890', 'Working on it...');
    await channel.sendProgressUpdate('sl:C1234567890', 'Done in 10s.', {
      done: true,
    });

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(appRef.current.client.chat.postMessage).toHaveBeenNthCalledWith(1, {
      channel: 'C1234567890',
      text: 'Working on it...',
    });
    expect(appRef.current.client.chat.update).toHaveBeenCalledTimes(1);
    expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
      channel: 'C1234567890',
      ts: '1710000000.100200',
      text: 'Done in 10s.',
    });

    appRef.current.client.chat.postMessage.mockClear();
    appRef.current.client.chat.update.mockClear();

    await channel.sendProgressUpdate('sl:C1234567890', 'Working on it...');

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('drops stale Slack progress updates after a generation is done', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    await channel.sendProgressUpdate('sl:C1234567890', 'Working on it...', {
      generation: 1,
    });
    await channel.sendProgressUpdate('sl:C1234567890', 'Done in 10s.', {
      done: true,
      generation: 1,
    });

    appRef.current.client.chat.postMessage.mockClear();
    appRef.current.client.chat.update.mockClear();

    await channel.sendProgressUpdate('sl:C1234567890', 'Still working...', {
      generation: 1,
    });

    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('starts a fresh Slack progress handle when generation changes under the same chat key', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    await channel.sendProgressUpdate('sl:C1234567890', 'Working on it...', {
      generation: 1,
    });
    await channel.sendProgressUpdate('sl:C1234567890', 'Working on it...', {
      generation: 2,
    });

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();

    await channel.sendProgressUpdate('sl:C1234567890', 'Done in old turn.', {
      done: true,
      replaceOnly: true,
      generation: 1,
    });
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();

    await channel.sendProgressUpdate('sl:C1234567890', 'Done in new turn.', {
      done: true,
      replaceOnly: true,
      generation: 3,
    });
    expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
      channel: 'C1234567890',
      ts: '1710000000.100200',
      text: 'Done in new turn.',
    });
  });

  it('restores Slack progress handles after process restart', async () => {
    const runtimeHome = fs.mkdtempSync('/tmp/gantry-slack-progress-');
    const savedHome = process.env.GANTRY_HOME;
    process.env.GANTRY_HOME = runtimeHome;
    try {
      const first = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts() as any,
      );
      await first.connect();
      await first.sendProgressUpdate('sl:C1234567890', 'Working on it...');

      const second = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts() as any,
      );
      await second.connect();
      appRef.current.client.chat.postMessage.mockClear();
      await second.sendProgressUpdate('sl:C1234567890', 'Done in 1s.', {
        done: true,
        replaceOnly: true,
      });

      expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
      expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
        channel: 'C1234567890',
        ts: '1710000000.100200',
        text: 'Done in 1s.',
      });
    } finally {
      if (savedHome === undefined) delete process.env.GANTRY_HOME;
      else process.env.GANTRY_HOME = savedHome;
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
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
    defaultSlackPermissionApproverIds.add('U_APPROVER');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-cmd',
        sourceAgentFolder: 'slack_main',
        targetJid: 'sl:C1234567890',
        threadId: '1711111111.000100',
        toolName: 'Bash',
        toolInput: {
          command: 'git status --short',
        },
      },
    );
    await flushSlackPromptRegistration();

    const postCall = vi
      .mocked(appRef.current.client.chat.postMessage)
      .mock.calls.at(-1)?.[0];
    expect(postCall?.thread_ts).toBe('1711111111.000100');
    expect(postCall?.text).toContain(
      'Approval applies to the parent conversation.',
    );
    expect(postCall?.text).toContain('Command:\n```\ngit status --short\n```');
    const actionsBlock = postCall?.blocks?.find(
      (block: any) => block.type === 'actions',
    ) as { elements?: Array<{ action_id?: string }> } | undefined;
    const actionIds = (actionsBlock?.elements || []).map(
      (element) => element.action_id,
    );
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(actionIds).toContain('gantry_perm_decision_allow_once');

    for (const actionId of SLACK_PERMISSION_DECISION_ACTION_IDS) {
      expect(appRef.current.actionHandlers.has(actionId)).toBe(true);
    }
    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: 'U_APPROVER', name: 'Approver' } },
      action: {
        value: JSON.stringify({
          requestId: 'perm-cmd',
          decision: 'allow_once',
        }),
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: true }),
    );
  });

  it('escapes permission metadata before rendering Slack mrkdwn blocks', () => {
    const blocks = buildPermissionPromptContentBlocks({
      title: 'Allow command?',
      bodyLines: [],
      contextLines: ['agent <@U123> & ops · scheduled job: <deploy>'],
      replyInMinutes: 5,
    });
    const contextBlock = blocks.find((block: any) => block.type === 'context');
    expect((contextBlock as any).elements[0].text).toBe(
      'agent &lt;@U123&gt; &amp; ops · scheduled job: &lt;deploy&gt;\nReply in 5m',
    );

    expect(buildPermissionReceiptBlocks('Allowed by <@U123> & ops')).toEqual([
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'Allowed by &lt;@U123&gt; &amp; ops' },
        ],
      },
    ]);
  });

  it('denies same-channel Slack permission decisions when no approver IDs are configured', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-no-approver',
        sourceAgentFolder: 'slack_main',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
      },
    );
    await flushSlackPromptRegistration();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U_ANY', name: 'Any User' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'perm-no-approver',
          decision: 'allow_once',
        }),
      },
    });

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        user: 'U_ANY',
        text: 'You are not allowed to decide this permission request.',
      }),
    );

    await channel.disconnect();
    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: false }),
    );
  });

  it('sends unauthorized Slack permission feedback to the callback channel', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-origin-feedback',
        sourceAgentFolder: 'slack_main',
        toolName: 'Bash',
      },
    );
    await flushSlackPromptRegistration();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C9999999999' },
        user: { id: 'U_ANY', name: 'Any User' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'perm-origin-feedback',
          decision: 'allow_once',
        }),
      },
    });

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C9999999999',
        user: 'U_ANY',
        text: 'You are not allowed to decide this permission request.',
      }),
    );

    await channel.disconnect();
    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: false }),
    );
  });

  it('authorizes Slack permission decisions through conversation approver hook', async () => {
    const isControlApproverAllowed = vi.fn(async () => true);
    const channel = new SlackChannel('xoxb-token', 'xapp-token', {
      ...createOpts({ default: [], agents: {} }),
      isControlApproverAllowed,
    } as any);
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-channel-allowlist',
        sourceAgentFolder: 'slack_main',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
      },
    );
    await flushSlackPromptRegistration();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U_CHANNEL_ADMIN', name: 'ChannelAdmin' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'perm-channel-allowlist',
          decision: 'allow_once',
        }),
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: true,
        decidedBy: 'ChannelAdmin',
      }),
    );
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'slack',
        conversationJid: 'sl:C1234567890',
        userId: 'U_CHANNEL_ADMIN',
      }),
    );
  });

  it('authorizes Slack same-channel decisions from block action container channel', async () => {
    const isControlApproverAllowed = vi.fn(async () => true);
    const channel = new SlackChannel('xoxb-token', 'xapp-token', {
      ...createOpts({ default: [], agents: {} }),
      isControlApproverAllowed,
    } as any);
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-container-channel',
        sourceAgentFolder: 'slack_main',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
      },
    );
    await flushSlackPromptRegistration();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        container: { channel_id: 'C1234567890' },
        user: { id: 'U_CHANNEL_ADMIN', name: 'ChannelAdmin' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'perm-container-channel',
          decision: 'allow_once',
        }),
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: true,
        decidedBy: 'ChannelAdmin',
      }),
    );
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'slack',
        conversationJid: 'sl:C1234567890',
        userId: 'U_CHANNEL_ADMIN',
      }),
    );
    expect(appRef.current.client.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it('fails closed when Slack same-channel callbacks omit channel context', async () => {
    const isControlApproverAllowed = vi.fn(async () => true);
    const channel = new SlackChannel('xoxb-token', 'xapp-token', {
      ...createOpts({ default: [], agents: {} }),
      isControlApproverAllowed,
    } as any);
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-missing-channel',
        sourceAgentFolder: 'slack_main',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
      },
    );
    await flushSlackPromptRegistration();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        user: { id: 'U_CHANNEL_ADMIN', name: 'ChannelAdmin' },
      },
      action: {
        value: JSON.stringify({
          requestId: 'perm-missing-channel',
          decision: 'allow_once',
        }),
      },
    });

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        user: 'U_CHANNEL_ADMIN',
        text: 'This approval request belongs to a different chat.',
      }),
    );
    expect(isControlApproverAllowed).not.toHaveBeenCalled();

    await channel.disconnect();
    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: false }),
    );
  });

  it('does not let an agent-scoped Slack approver decide another agent request', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts({
        default: [],
        agents: {
          agent_one: ['U_APPROVER'],
          agent_two: ['U_OTHER'],
        },
      }) as any,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-agent-scope',
        sourceAgentFolder: 'agent_two',
        toolName: 'Bash',
      },
    );
    await flushSlackPromptRegistration();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: 'U_APPROVER', name: 'Wrong Agent Approver' } },
      action: {
        value: JSON.stringify({
          requestId: 'perm-agent-scope',
          decision: 'allow_once',
        }),
      },
    });

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'U_APPROVER',
        text: 'You are not allowed to decide this permission request.',
      }),
    );

    await channel.disconnect();
    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: false }),
    );
  });

  it('uses live Slack approver settings for permission decisions', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts({
        default: ['U_REVOKED'],
        agents: {},
      }) as any,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-revoked',
        sourceAgentFolder: 'slack_main',
        toolName: 'Bash',
      },
    );
    await flushSlackPromptRegistration();
    currentControlAllowlist.current = { default: [], agents: {} };

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: 'U_REVOKED', name: 'Revoked Approver' } },
      action: {
        value: JSON.stringify({
          requestId: 'perm-revoked',
          decision: 'allow_once',
        }),
      },
    });

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'U_REVOKED',
        text: 'You are not allowed to decide this permission request.',
      }),
    );

    await channel.disconnect();
    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: false }),
    );
  });

  it('resolves Slack single-select user question from action callback', async () => {
    defaultSlackPermissionApproverIds.add('U123');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-1',
      sourceAgentFolder: 'slack_main',
      threadId: '1711111111.000200',
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
    await flushSlackPromptRegistration();

    const postCall = vi
      .mocked(appRef.current.client.chat.postMessage)
      .mock.calls.at(-1)?.[0];
    expect(postCall?.thread_ts).toBe('1711111111.000200');
    expect(postCall?.text).toContain('*Pick one*');
    expect(postCall?.text).toContain('Preferred option?');
    expect(postCall?.text).not.toContain('Source: slack_main');
    expect(postCall?.text).not.toContain('Thread: 1711111111.000200');

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_userq_select',
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

  it('resolves Slack user question from the Other free-text modal', async () => {
    defaultSlackPermissionApproverIds.add('U123');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-other-1',
      sourceAgentFolder: 'slack_main',
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
    await flushSlackPromptRegistration();

    const otherHandler =
      appRef.current.actionHandlers.get('gantry_userq_other');
    expect(otherHandler).toBeTypeOf('function');
    const ack = vi.fn().mockResolvedValue(undefined);
    await otherHandler?.({
      ack,
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U123', name: 'Alice' },
        trigger_id: 'trigger-123',
      },
      action: {
        value: JSON.stringify({ requestId: 'userq-other-1', questionIndex: 0 }),
      },
    });
    expect(appRef.current.client.views.open).toHaveBeenCalledTimes(1);
    const openCall = vi
      .mocked(appRef.current.client.views.open)
      .mock.calls.at(-1)?.[0] as any;
    expect(openCall?.trigger_id).toBe('trigger-123');
    expect(openCall?.view?.callback_id).toBe('gantry_userq_other_modal');

    const viewHandler = appRef.current.viewHandlers.get(
      'gantry_userq_other_modal',
    );
    expect(viewHandler).toBeTypeOf('function');
    const viewAck = vi.fn().mockResolvedValue(undefined);
    await viewHandler?.({
      ack: viewAck,
      body: { user: { id: 'U123', name: 'Alice' } },
      view: {
        private_metadata: openCall?.view?.private_metadata,
        state: {
          values: {
            gantry_userq_other_block: {
              gantry_userq_other_input: { value: 'My custom answer' },
            },
          },
        },
      },
    });

    const answer = await answerPromise;
    expect(ack).toHaveBeenCalledTimes(1);
    expect(viewAck).toHaveBeenCalledTimes(1);
    expect(answer.answers).toEqual({ 'Preferred option?': 'My custom answer' });
    expect(answer.answeredBy).toBe('Alice');
  });

  it('blocks unauthorized Slack user-question answers when approvers are configured', async () => {
    defaultSlackPermissionApproverIds.add('U_APPROVER');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-auth-1',
      sourceAgentFolder: 'slack_main',
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
    await flushSlackPromptRegistration();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_userq_select',
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
    defaultSlackPermissionApproverIds.add('U123');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-2',
      sourceAgentFolder: 'slack_main',
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
    await flushSlackPromptRegistration();

    const selectHandler = appRef.current.actionHandlers.get(
      'gantry_userq_select',
    );
    const doneHandler = appRef.current.actionHandlers.get('gantry_userq_done');
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
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const answerPromise = channel.requestUserAnswer('sl:C1234567890', {
      requestId: 'userq-timeout',
      sourceAgentFolder: 'slack_main',
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
      sourceAgentFolder: 'slack_main',
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

    await flushSlackPromptRegistration();
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

  it('splits native Slack stream append payloads to <=12000 chars', async () => {
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
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(2200);

    await channel.sendStreamingChunk('sl:C1234567890', 'seed');
    await channel.sendStreamingChunk('sl:C1234567890', 'x'.repeat(13050));

    const appendCalls = vi
      .mocked(appRef.current.client.apiCall)
      .mock.calls.filter(
        ([method]: [string]) => method === 'chat.appendStream',
      );
    expect(appendCalls).toHaveLength(2);
    expect((appendCalls[0]?.[1] as any).markdown_text.length).toBe(12000);
    expect((appendCalls[1]?.[1] as any).markdown_text.length).toBe(1050);
  });

  it('clamps native Slack append retry_after waits to a bounded maximum', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();
    vi.useFakeTimers();

    let appendCallCount = 0;
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream') {
          appendCallCount += 1;
          if (appendCallCount === 1) {
            return { ok: false, error: 'ratelimited', retry_after: 999_999 };
          }
          return { ok: true };
        }
        if (method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );

    try {
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(2200);

      await channel.sendStreamingChunk('sl:C1234567890', 'seed');
      const flushPromise = channel.sendStreamingChunk('sl:C1234567890', 'x', {
        done: true,
      });

      await Promise.resolve();
      const appendCallsBeforeWait = vi
        .mocked(appRef.current.client.apiCall)
        .mock.calls.filter(
          ([method]: [string]) => method === 'chat.appendStream',
        );
      expect(appendCallsBeforeWait).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(4999);
      const appendCallsBeforeClamp = vi
        .mocked(appRef.current.client.apiCall)
        .mock.calls.filter(
          ([method]: [string]) => method === 'chat.appendStream',
        );
      expect(appendCallsBeforeClamp).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(flushPromise).resolves.toBe(true);

      const appendCalls = vi
        .mocked(appRef.current.client.apiCall)
        .mock.calls.filter(
          ([method]: [string]) => method === 'chat.appendStream',
        );
      expect(appendCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains unsent suffix through fallback when done append fails mid-delta', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    let appendCallCount = 0;
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string, payload: Record<string, unknown>) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream') {
          appendCallCount += 1;
          if (appendCallCount === 1) return { ok: true, payload };
          return { ok: false, error: 'append_failed' };
        }
        if (method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(2200);

    await channel.sendStreamingChunk('sl:C1234567890', 'seed');

    const delivered = await channel.sendStreamingChunk(
      'sl:C1234567890',
      'x'.repeat(13050),
      {
        done: true,
      },
    );

    expect(delivered).toBe(true);
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        text: 'x'.repeat(1050),
      }),
    );
    const appendCalls = vi
      .mocked(appRef.current.client.apiCall)
      .mock.calls.filter(
        ([method]: [string]) => method === 'chat.appendStream',
      );
    expect(appendCalls).toHaveLength(2);
    expect((appendCalls[0]?.[1] as any).markdown_text.length).toBe(12000);
    expect((appendCalls[1]?.[1] as any).markdown_text.length).toBe(1050);
    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'chat.stopStream',
      expect.objectContaining({
        channel: 'C1234567890',
        ts: '1710000000.222333',
      }),
    );
  });

  it('best-effort stops native stream on done when append degrades with no sent prefix', async () => {
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
          return { ok: false, error: 'append_failed' };
        }
        if (method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(2200);

    await channel.sendStreamingChunk('sl:C1234567890', 'seed');

    const delta = 'snake_case *literal* ~literal~';
    const delivered = await channel.sendStreamingChunk(
      'sl:C1234567890',
      delta,
      {
        done: true,
      },
    );

    expect(delivered).toBe(true);
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        text: 'snake_case _literal_ ~literal~',
      }),
    );
    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'chat.stopStream',
      expect.objectContaining({
        channel: 'C1234567890',
        ts: '1710000000.222333',
      }),
    );
  });

  it('adds retry-tail metadata when done append fallback cannot send remaining suffix', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    let appendCallCount = 0;
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string, payload: Record<string, unknown>) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream') {
          appendCallCount += 1;
          if (appendCallCount === 1) return { ok: true, payload };
          return { ok: false, error: 'append_failed' };
        }
        if (method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );
    vi.mocked(appRef.current.client.chat.postMessage).mockRejectedValueOnce(
      new Error('fallback delivery unavailable'),
    );

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(2200);

    await channel.sendStreamingChunk('sl:C1234567890', 'seed');

    await expect(
      channel.sendStreamingChunk('sl:C1234567890', 'x'.repeat(13050), {
        done: true,
      }),
    ).rejects.toMatchObject({
      name: 'PartialSlackNativeStreamAppendDeliveryError',
      partialMessageDelivery: true,
      retryTail: {
        canonicalText: 'x'.repeat(1050),
        providerPayload: expect.objectContaining({
          provider: 'slack',
          channelId: 'C1234567890',
        }),
      },
    });
    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'chat.stopStream',
      expect.objectContaining({
        channel: 'C1234567890',
        ts: '1710000000.222333',
      }),
    );
  });

  it('resumes fallback streaming from unsent suffix after native append partial failure', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    let appendCallCount = 0;
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string, payload: Record<string, unknown>) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: '1710000000.222333' };
        }
        if (method === 'chat.appendStream') {
          appendCallCount += 1;
          if (appendCallCount === 1) return { ok: true, payload };
          return { ok: false, error: 'append_failed' };
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
      .mockReturnValueOnce(2200)
      .mockReturnValueOnce(3400);

    await channel.sendStreamingChunk('sl:C1234567890', 'seed');

    await expect(
      channel.sendStreamingChunk('sl:C1234567890', 'x'.repeat(13050)),
    ).rejects.toMatchObject({
      name: 'PartialSlackNativeStreamAppendDeliveryError',
      partialMessageDelivery: true,
      deliveredChunks: 1,
      totalChunks: 2,
      sentPrefix: 'x'.repeat(12000),
    });

    await channel.sendStreamingChunk('sl:C1234567890', 'y', {
      done: true,
    });

    const appendCalls = vi
      .mocked(appRef.current.client.apiCall)
      .mock.calls.filter(
        ([method]: [string]) => method === 'chat.appendStream',
      );
    expect(appendCalls).toHaveLength(2);
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1234567890',
        text: `${'x'.repeat(1050)}y`,
      }),
    );
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

  it('sends all Slack fallback stream parts in order', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockResolvedValue({ ok: false });

    await channel.sendStreamingChunk('sl:C1234567890', 'x'.repeat(4500), {
      done: true,
    });

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(appRef.current.client.chat.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: 'C1234567890',
        text: 'x'.repeat(4000),
      }),
    );
    expect(appRef.current.client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: 'C1234567890',
        text: 'x'.repeat(500),
      }),
    );
  });

  it('uses snippet fallback hook for very large Slack stream fallback output when configured', async () => {
    class SlackChannelWithStreamSnippetFallback extends SlackChannel {
      fallbackCalls: Array<Record<string, unknown>> = [];

      protected override async sendSnippetFallback(input: {
        channelId: string;
        text: string;
        threadId?: string;
        reason: string;
      }) {
        this.fallbackCalls.push(input);
        return {
          fallbackArtifactId: 'slack-stream-artifact-1',
          externalMessageId: '1710000000.888999',
        };
      }
    }

    const channel = new SlackChannelWithStreamSnippetFallback(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockResolvedValue({ ok: false });

    const delivered = await channel.sendStreamingChunk(
      'sl:C1234567890',
      'x'.repeat(20000),
      { done: true },
    );

    expect(delivered).toBe(true);
    expect(channel.fallbackCalls).toEqual([
      expect.objectContaining({
        channelId: 'C1234567890',
        reason: 'stream_output_too_large',
      }),
    ]);
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('surfaces partial delivery when Slack fallback stream part delivery fails', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockResolvedValue({ ok: false });
    vi.mocked(appRef.current.client.chat.postMessage)
      .mockResolvedValueOnce({
        ok: true,
        ts: '1710000000.200300',
      } as any)
      .mockRejectedValueOnce(new Error('fallback second part failed'));

    await expect(
      channel.sendStreamingChunk('sl:C1234567890', 'x'.repeat(4500), {
        done: true,
      }),
    ).rejects.toMatchObject({
      name: 'PartialSlackStreamingFallbackDeliveryError',
      partialMessageDelivery: true,
      deliveredChunks: 1,
      totalChunks: 2,
      retryTail: {
        canonicalText: 'x'.repeat(500),
        providerPayload: expect.objectContaining({
          provider: 'slack',
          channelId: 'C1234567890',
        }),
      },
    });
  });

  it('throws retry-tail partial delivery when a stale fallback message update fails', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    vi.mocked(appRef.current.client.apiCall).mockResolvedValue({ ok: false });
    vi.mocked(appRef.current.client.chat.postMessage).mockResolvedValue({
      ok: true,
      ts: '1710000000.200300',
    } as any);
    vi.mocked(appRef.current.client.chat.update).mockRejectedValueOnce(
      new Error('fallback update failed'),
    );

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(2200);

    await channel.sendStreamingChunk('sl:C1234567890', 'visible');

    await expect(
      channel.sendStreamingChunk('sl:C1234567890', ' suffix', {
        done: true,
      }),
    ).rejects.toMatchObject({
      name: 'PartialSlackStreamingFallbackDeliveryError',
      partialMessageDelivery: true,
      deliveredChunks: 1,
      totalChunks: 2,
      deliveredParts: 0,
      totalParts: 2,
      externalMessageId: '1710000000.200300',
      externalMessageIds: ['1710000000.200300'],
      retryTail: {
        canonicalText: ' suffix',
        providerPayload: expect.objectContaining({
          provider: 'slack',
          channelId: 'C1234567890',
          externalMessageId: '1710000000.200300',
          externalMessageIds: ['1710000000.200300'],
          deliveredParts: 0,
          totalParts: 2,
        }),
      },
    });
    expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
      channel: 'C1234567890',
      ts: '1710000000.200300',
      text: 'visible suffix',
    });
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
    defaultSlackPermissionApproverIds.add('U_APPROVER');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const decisionPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'req-1',
        sourceAgentFolder: 'test',
        toolName: 'shell',
      },
    );
    await flushSlackPromptRegistration();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    expect(actionHandler).toBeTypeOf('function');
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: 'U_APPROVER', name: 'Approver' } },
      action: {
        value: JSON.stringify({
          requestId: 'req-1',
          decision: 'allow_once',
        }),
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
