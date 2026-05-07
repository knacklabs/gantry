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
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@core/platform/group-folder.js', () => ({
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

import { createSlackChannel, SlackChannel } from '@core/channels/slack.js';

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
          isMain: false,
          memoryScope: 'conversation',
        },
      },
    })),
  };
}

describe('Slack channel', () => {
  let savedMyclawHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedMyclawHome = process.env.MYCLAW_HOME;
    delete process.env.MYCLAW_HOME;
    defaultSlackPermissionApproverIds.clear();
  });

  afterEach(() => {
    if (savedMyclawHome === undefined) delete process.env.MYCLAW_HOME;
    else process.env.MYCLAW_HOME = savedMyclawHome;
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

  it('delivers unregistered Slack DMs so agent DM access can route centrally', async () => {
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

  it('does not create Slack progress for replace-only updates without existing state', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
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
      createOpts() as any,
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

  it('restores Slack progress handles after process restart', async () => {
    const runtimeHome = fs.mkdtempSync('/tmp/myclaw-slack-progress-');
    const savedHome = process.env.MYCLAW_HOME;
    process.env.MYCLAW_HOME = runtimeHome;
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
      if (savedHome === undefined) delete process.env.MYCLAW_HOME;
      else process.env.MYCLAW_HOME = savedHome;
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
      createOpts() as any,
    );
    await channel.connect();

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      {
        requestId: 'perm-cmd',
        sourceAgentFolder: 'slack_main',
        threadId: '1711111111.000100',
        toolName: 'Bash',
        toolInput: {
          command: 'git status --short',
        },
      },
    );

    const postCall = vi
      .mocked(appRef.current.client.chat.postMessage)
      .mock.calls.at(-1)?.[0];
    expect(postCall?.thread_ts).toBe('1711111111.000100');
    expect(postCall?.text).toContain('Thread: 1711111111.000100');
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

  it('denies same-channel Slack permission decisions when no approver IDs are configured', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
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

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_perm_decision',
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
          decision: 'approve',
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
      createOpts() as any,
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

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_perm_decision',
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
          decision: 'approve',
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

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_perm_decision',
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
          decision: 'approve',
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

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: 'U_APPROVER', name: 'Wrong Agent Approver' } },
      action: {
        value: JSON.stringify({
          requestId: 'perm-agent-scope',
          decision: 'approve',
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
    currentControlAllowlist.current = { default: [], agents: {} };

    const actionHandler = appRef.current.actionHandlers.get(
      'myclaw_perm_decision',
    );
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: 'U_REVOKED', name: 'Revoked Approver' } },
      action: {
        value: JSON.stringify({
          requestId: 'perm-revoked',
          decision: 'approve',
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
      createOpts() as any,
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

    const postCall = vi
      .mocked(appRef.current.client.chat.postMessage)
      .mock.calls.at(-1)?.[0];
    expect(postCall?.thread_ts).toBe('1711111111.000200');
    expect(postCall?.text).toContain('Source: slack_main');
    expect(postCall?.text).toContain('Thread: 1711111111.000200');

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
    defaultSlackPermissionApproverIds.add('U_APPROVER');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
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
    defaultSlackPermissionApproverIds.add('U123');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
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
    defaultSlackPermissionApproverIds.add('U_APPROVER');
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
        sourceAgentFolder: 'test',
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
