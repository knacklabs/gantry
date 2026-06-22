import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('@core/config/index.js', () => ({
  ASSISTANT_NAME: 'Andy',
  PERMISSION_APPROVAL_TIMEOUT_MS: 300000,
  getTelegramBotToken: () => process.env.TELEGRAM_BOT_TOKEN || '',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock workspace-folder (used by downloadFile)
vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    pollingRunning = false;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 987 }),
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      setMyCommands: vi.fn().mockResolvedValue(true),
      config: { use: vi.fn() },
      raw: null as any,
    };

    constructor(token: string) {
      this.token = token;
      this.api.raw = {
        sendMessage: vi.fn((params: any) => {
          const { chat_id, text, ...rest } = params;
          return this.api.sendMessage(chat_id.toString(), text, rest);
        }),
        sendMessageDraft: vi.fn((params: any) => {
          const { chat_id, draft_id, text, ...rest } = params;
          return this.api.sendMessageDraft(chat_id, draft_id, text, rest);
        }),
      };
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    use(_middleware: Handler) {}

    start(opts: { onStart: (botInfo: any) => void }) {
      if (this.pollingRunning) return;
      this.pollingRunning = true;
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {
      this.pollingRunning = false;
    }

    isRunning() {
      return this.pollingRunning;
    }
  },
}));

import fs from 'fs';
import {
  createTelegramChannel,
  TelegramChannel,
  TelegramChannelOpts,
} from '@core/channels/telegram.js';
import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';
import { writeTelegramFetchResponseToFile } from '@core/channels/telegram-file-download.js';
import { logger } from '@core/infrastructure/logging/logger.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    conversationRoutes: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    runtimeSettings: vi.fn(() => ({
      providers: {
        telegram: { enabled: true },
      },
      providerConnections: {
        telegram_default: {
          provider: 'telegram',
          label: 'Telegram',
          runtimeSecretRefs: {},
        },
      },
      conversations: {
        whatsapp_main_conversation: {
          providerConnection: 'telegram_default',
          externalId: '100200300',
          kind: 'group',
          displayName: 'Test Group',
          senderPolicy: { allow: '*', mode: 'trigger' },
          controlApprovers: ['12345', '222', '333', '444'],
        },
      },
      bindings: {
        whatsapp_main_binding: {
          agent: 'whatsapp_main',
          conversation: 'whatsapp_main_conversation',
          trigger: '@Andy',
          addedAt: '2024-01-01T00:00:00.000Z',
          requiresTrigger: true,
          memoryScope: 'conversation',
        },
      },
      storage: {
        postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
      },
      credentialBroker: {
        model_gateway: {
          postgres: {
            urlEnv: 'GANTRY_MODEL_GATEWAY_DATABASE_URL',
            schema: 'model_gateway',
          },
        },
      },
      memory: {
        enabled: true,
        embeddings: {
          enabled: false,
          provider: 'disabled',
          model: 'text-embedding-3-small',
        },
        dreaming: { enabled: true },
        llm: {
          models: {
            extractor: 'haiku',
            dreaming: 'sonnet',
            consolidation: 'sonnet',
          },
        },
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
  reply_to_message?: any;
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
      reply_to_message: overrides.reply_to_message,
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

async function triggerCallbackQuery(ctx: {
  callbackQuery: {
    data: string;
    from?: { id: number; first_name?: string; username?: string };
    message?: { chat?: { id: number }; message_thread_id?: number };
  };
  chat?: { id: number };
  from?: { id: number; first_name?: string; username?: string };
  api?: { sendMessage: ReturnType<typeof vi.fn> };
  answerCallbackQuery: ReturnType<typeof vi.fn>;
}) {
  const handlers = currentBot().filterHandlers.get('callback_query:data') || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

// Helper: flush pending microtasks (for async downloadFile().then() chains)
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TelegramChannel', () => {
  let savedGantryHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedGantryHome = process.env.GANTRY_HOME;
    delete process.env.GANTRY_HOME;

    // Mock fs operations used by downloadFile
    vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined as any);
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);

    // Mock global fetch for file downloads
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      }),
    );
  });

  afterEach(() => {
    configurePendingInteractionDurability(null);
    if (savedGantryHome === undefined) delete process.env.GANTRY_HOME;
    else process.env.GANTRY_HOME = savedGantryHome;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders todo messages in the active Telegram topic', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();
    currentBot()
      .api.sendMessage.mockResolvedValueOnce({ message_id: 101 })
      .mockResolvedValueOnce({ message_id: 202 });

    await channel.renderAgentTodo('tg:-100123', {
      threadId: '42',
      items: [{ id: '1', title: 'First', status: 'pending' }],
    });
    await channel.renderAgentTodo('tg:-100123', {
      threadId: '77',
      items: [{ id: '2', title: 'Second', status: 'pending' }],
    });
    await channel.renderAgentTodo('tg:-100123', {
      threadId: '42',
      items: [{ id: '1', title: 'First', status: 'completed' }],
    });

    expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
      1,
      '-100123',
      expect.any(String),
      expect.objectContaining({ message_thread_id: 42 }),
    );
    expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
      2,
      '-100123',
      expect.any(String),
      expect.objectContaining({ message_thread_id: 77 }),
    );
    expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
      '-100123',
      101,
      expect.any(String),
      expect.any(Object),
    );
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().api.setMyCommands).toHaveBeenCalledWith([
        { command: 'gantry', description: 'Open Gantry commands' },
        { command: 'chatid', description: 'Show this chat ID' },
        { command: 'ping', description: 'Check bot status' },
      ]);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers unregistered Telegram private chats to the shared persistence policy', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 999999,
        chatType: 'private',
        text: 'Unknown private chat',
        firstName: 'Ravi',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Ravi',
        'telegram',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:999999',
        expect.objectContaining({
          chat_jid: 'tg:999999',
          provider: 'telegram',
          sender: '99001',
          content: 'Unknown private chat',
        }),
      );
    });

    it('skips bot commands (/chatid, /ping) but passes other / messages through', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Bot commands should be skipped
      const ctx1 = createTextCtx({ text: '/chatid' });
      await triggerTextMessage(ctx1);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      const ctx2 = createTextCtx({ text: '/ping' });
      await triggerTextMessage(ctx2);
      expect(opts.onMessage).not.toHaveBeenCalled();

      // Non-bot /commands should flow through
      const ctx3 = createTextCtx({ text: '/custom-command' });
      await triggerTextMessage(ctx3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/custom-command' }),
      );

      const ctx4 = createTextCtx({ text: '/gantry status', messageId: 4 });
      await triggerTextMessage(ctx4);
      expect(opts.onMessage).toHaveBeenCalledTimes(2);
      expect(opts.onMessage).toHaveBeenLastCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/gantry status' }),
      );
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('extracts reply_to fields when replying to a text message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Yes, on my way!',
        reply_to_message: {
          message_id: 42,
          text: 'Are you coming tonight?',
          from: { id: 777, first_name: 'Bob', username: 'bob_user' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'Yes, on my way!',
          reply_to_message_id: '42',
          reply_to_message_content: 'Are you coming tonight?',
          reply_to_sender_name: 'Bob',
        }),
      );
    });

    it('uses caption when reply has no text (media reply)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Nice photo!',
        reply_to_message: {
          message_id: 50,
          caption: 'Check this out',
          from: { id: 888, first_name: 'Carol' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_content: 'Check this out',
        }),
      );
    });

    it('falls back to Unknown when reply sender has no from', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Interesting',
        reply_to_message: {
          message_id: 60,
          text: 'Channel post',
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '60',
          reply_to_sender_name: 'Unknown',
        }),
      );
    });

    it('does not set reply fields when no reply_to_message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Just a normal message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: undefined,
          reply_to_message_content: undefined,
          reply_to_sender_name: undefined,
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('downloads photo and includes attachment storage ref in content', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          photo: [
            { file_id: 'small_id', width: 90 },
            { file_id: 'large_id', width: 800 },
          ],
        },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('large_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo] (attachments/photo_1.jpg)',
          attachments: [
            expect.objectContaining({ storageRef: 'attachments/photo_1.jpg' }),
          ],
        }),
      );
    });

    it('downloads photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        caption: 'Look at this',
        extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo] (attachments/photo_1.jpg) Look at this',
        }),
      );
    });

    it('falls back to placeholder when getFile returns no file_path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // getFile succeeds but returns no file_path (lines 121-123)
      currentBot().api.getFile.mockResolvedValueOnce({});

      const ctx = createMediaCtx({
        caption: 'Uploaded',
        extra: { photo: [{ file_id: 'no_path_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Uploaded' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { fileId: 'no_path_id' },
        'Telegram getFile returned no file_path',
      );
    });

    it('falls back to placeholder when fetch response is not ok', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // getFile succeeds with a file_path, but fetch returns non-ok (lines 139-144)
      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'photos/file_0.jpg',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      );

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'fetch_fail_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { fileId: 'fetch_fail_id', status: 404 },
        'Telegram file download failed',
      );
    });

    it('falls back to placeholder when file exceeds max size via content-length', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'photos/file_0.jpg',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: {
            get: (name: string) =>
              name === 'content-length' ? String(60 * 1024 * 1024) : null,
          },
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        }),
      );

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'too_large_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          declaredLength: 60 * 1024 * 1024,
        }),
        'Telegram file exceeds max allowed size',
      );
    });

    it('falls back to placeholder when download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Make getFile reject
      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        caption: 'Check this',
        extra: { photo: [{ file_id: 'bad_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Check this' }),
      );
    });

    it('rejects unsafe Telegram file paths', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: '../secrets/token.txt',
      });

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'unsafe_path', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { fileId: 'unsafe_path', filePath: '[unsafe-file-path]' },
        'Rejected unsafe Telegram file path',
      );
    });

    it('redacts bot token in download error logs', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('super-secret-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'photos/file_0.jpg',
      });
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValue(
            new Error('request failed for super-secret-token endpoint'),
          ),
      );

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'redact_test', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'redact_test',
          error: expect.stringContaining('[REDACTED_BOT_TOKEN]'),
        }),
        'Failed to download Telegram file',
      );
    });

    it('downloads document and includes filename and path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'documents/file_0.pdf',
      });

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf', file_id: 'doc_id' } },
      });
      await triggerMediaMessage('message:document', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('doc_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Document: report.pdf] (attachments/report.pdf)',
        }),
      );
    });

    it('downloads video', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'videos/file_0.mp4',
      });

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'vid_id' } },
      });
      await triggerMediaMessage('message:video', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('vid_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Video] (attachments/video_1.mp4)',
        }),
      );
    });

    it('downloads voice message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'voice/file_0.oga',
      });

      const ctx = createMediaCtx({
        extra: { voice: { file_id: 'voice_id' } },
      });
      await triggerMediaMessage('message:voice', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('voice_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message] (attachments/voice_1.oga)',
        }),
      );
    });

    it('downloads audio with original filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'audio/file_0.mp3',
      });

      const ctx = createMediaCtx({
        extra: { audio: { file_id: 'audio_id', file_name: 'song.mp3' } },
      });
      await triggerMediaMessage('message:audio', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Audio] (attachments/song.mp3)',
        }),
      );
    });

    it('stores sticker with emoji (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(currentBot().api.getFile).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('registers first private-DM media routes before delivery', async () => {
      const ensureMessageRoute = vi.fn(async () => undefined);
      const opts = createTestOpts({
        ensureMessageRoute,
        conversationRoutes: vi.fn(() => ({})),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        chatId: 999999,
        chatType: 'private',
        extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(ensureMessageRoute).toHaveBeenCalledWith(
        'tg:999999',
        expect.objectContaining({
          chat_jid: 'tg:999999',
          provider: 'telegram',
          sender: '99001',
          content: '[Photo]',
        }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:999999',
        expect.objectContaining({
          chat_jid: 'tg:999999',
          provider: 'telegram',
          content: '[Photo]',
        }),
      );
      expect(currentBot().api.getFile).not.toHaveBeenCalled();
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'documents/file_0.bin',
      });

      const ctx = createMediaCtx({
        extra: { document: { file_id: 'doc_id' } },
      });
      await triggerMediaMessage('message:document', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Document: file] (attachments/file.bin)',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('download + polling edge cases', () => {
    it('throws when download response has neither reader nor arrayBuffer', async () => {
      await expect(
        writeTelegramFetchResponseToFile(
          { body: null, headers: { get: () => null } },
          '/tmp/missing-body.bin',
        ),
      ).rejects.toThrow('Telegram download response body is missing');
    });

    it('returns false when arrayBuffer response exceeds max size', async () => {
      const large = new Uint8Array(51 * 1024 * 1024).buffer;
      const wrote = await writeTelegramFetchResponseToFile(
        {
          body: null,
          headers: { get: () => null },
          arrayBuffer: vi.fn().mockResolvedValue(large),
        },
        '/tmp/too-large.bin',
      );

      expect(wrote).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bytes: 51 * 1024 * 1024 }),
        'Telegram file exceeds max allowed size',
      );
    });

    it('streams chunks to disk when reader is available', async () => {
      const write = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn().mockResolvedValue(undefined);
      const openSpy = vi.spyOn(fs.promises, 'open').mockResolvedValue({
        write,
        close,
      } as any);
      const unlinkSpy = vi
        .spyOn(fs.promises, 'unlink')
        .mockResolvedValue(undefined);
      const reader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: new Uint8Array([1, 2, 3]),
          })
          .mockResolvedValueOnce({
            done: false,
            value: new Uint8Array([4]),
          })
          .mockResolvedValueOnce({ done: true }),
      };

      const wrote = await writeTelegramFetchResponseToFile(
        {
          body: { getReader: () => reader },
          headers: { get: () => null },
        },
        '/tmp/stream-success.bin',
      );

      expect(wrote).toBe(true);
      expect(openSpy).toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it('cleans up partial file when streamed download exceeds max size', async () => {
      vi.spyOn(fs.promises, 'open').mockResolvedValue({
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as any);
      const unlinkSpy = vi
        .spyOn(fs.promises, 'unlink')
        .mockResolvedValue(undefined);
      const reader = {
        read: vi.fn().mockResolvedValueOnce({
          done: false,
          value: { byteLength: 60 * 1024 * 1024 },
        }),
      };

      const wrote = await writeTelegramFetchResponseToFile(
        {
          body: { getReader: () => reader },
          headers: { get: () => null },
        },
        '/tmp/stream-too-large.bin',
      );

      expect(wrote).toBe(false);
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/stream-too-large.bin');
    });

    it('rethrows stream read errors and marks partial file for cleanup', async () => {
      vi.spyOn(fs.promises, 'open').mockResolvedValue({
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as any);
      const unlinkSpy = vi
        .spyOn(fs.promises, 'unlink')
        .mockResolvedValue(undefined);
      const reader = {
        read: vi.fn().mockRejectedValue(new Error('stream read failed')),
      };

      await expect(
        writeTelegramFetchResponseToFile(
          {
            body: { getReader: () => reader },
            headers: { get: () => null },
          },
          '/tmp/stream-throw.bin',
        ),
      ).rejects.toThrow('stream read failed');
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/stream-throw.bin');
    });

    it('retries polling after failure and executes retry callback', async () => {
      vi.useFakeTimers();
      try {
        const opts = createTestOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        currentBot().pollingRunning = false;
        currentBot().start = vi.fn().mockRejectedValue(new Error('poll crash'));
        const startPollingSpy = vi.spyOn(channel as any, 'startPolling');

        (channel as any).startPolling();
        await vi.waitFor(() =>
          expect(logger.error).toHaveBeenCalledWith(
            { err: expect.any(Error) },
            'Telegram polling failed',
          ),
        );

        // Execute the scheduled retry callback to cover timer callback path.
        vi.runOnlyPendingTimers();
        expect(startPollingSpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('retains a newly acquired lease when the poller is already running', async () => {
      vi.useFakeTimers();
      try {
        const lostHandlers: Array<(err: Error) => void> = [];
        const releases = [vi.fn().mockResolvedValue(undefined), vi.fn()];
        releases[1]!.mockResolvedValue(undefined);
        const leases = releases.map((release) => ({
          release,
          onLost: vi.fn((handler: (err: Error) => void) => {
            lostHandlers.push(handler);
          }),
        }));
        const runtimeLease = {
          tryAcquire: vi
            .fn()
            .mockResolvedValueOnce(leases[0])
            .mockResolvedValueOnce(leases[1]),
        };
        const channel = new TelegramChannel(
          'test-token',
          createTestOpts({ runtimeLease }),
        );

        await channel.connect();
        await vi.waitFor(() =>
          expect(runtimeLease.tryAcquire).toHaveBeenCalledTimes(1),
        );
        const startSpy = vi.spyOn(currentBot(), 'start');

        lostHandlers[0]!(new Error('lease connection lost'));
        vi.runOnlyPendingTimers();
        await vi.waitFor(() =>
          expect(runtimeLease.tryAcquire).toHaveBeenCalledTimes(2),
        );

        expect(startSpy).not.toHaveBeenCalled();
        expect(releases[1]).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalledWith(
          'Telegram polling stopped unexpectedly',
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'MarkdownV2' },
      );
    });

    it('renders scheduler dead-letter action affordances as Telegram buttons', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Paused after failures', {
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

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Paused after failures',
        expect.objectContaining({
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Retry now', callback_data: 'dl:retry' },
                { text: 'Pause job', callback_data: 'dl:pause' },
              ],
              [{ text: 'Open in scheduler', callback_data: 'dl:open' }],
            ],
          },
        }),
      );
    });

    it('fails closed when Telegram scheduler action buttons are clicked', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const callbackCtx = {
        callbackQuery: { data: 'dl:retry' },
        chat: { id: 100200300 },
        from: { id: 111 },
        answerCallbackQuery: vi.fn(),
      };

      await triggerCallbackQuery(callbackCtx);

      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Open the scheduler surface or use scheduler tools to run this action.',
        show_alert: true,
      });
    });

    it('routes Telegram live stop action buttons through the message action callback', async () => {
      const opts = createTestOpts({ onMessageAction: vi.fn() } as any);
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Working...', {
        actionAffordances: [
          { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
        ],
      });

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Working\\.\\.\\.',
        expect.objectContaining({
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Stop', callback_data: 'lt:stop:token-1' }],
            ],
          },
        }),
      );

      const callbackCtx = {
        callbackQuery: {
          data: 'lt:stop:token-1',
          message: {
            chat: { id: 100200300 },
            message_thread_id: 42,
          },
        },
        from: { id: 111 },
        answerCallbackQuery: vi.fn(),
      };
      await triggerCallbackQuery(callbackCtx);

      expect(opts.onMessageAction).toHaveBeenCalledWith({
        kind: 'live_turn_stop',
        conversationJid: 'tg:100200300',
        threadId: '42',
        userId: '111',
        actionToken: 'token-1',
      });
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Stopping current run.',
      });
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        { parse_mode: 'MarkdownV2' },
      );
    });

    it('splits messages near the 3500 soft budget', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      const result = await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(3500),
        { parse_mode: 'MarkdownV2' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(1500),
        { parse_mode: 'MarkdownV2' },
      );
      expect(result).toEqual(
        expect.objectContaining({
          deliveredParts: 2,
          totalParts: 2,
          externalMessageIds: ['987', '987'],
          warnings: ['telegram.message.chunked:2:3500'],
        }),
      );
    });

    it('splits long messages without breaking emoji surrogate pairs', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const emoji = '🙂';
      const longText = `${'x'.repeat(3499)}${emoji}tail`;
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      const firstChunk = currentBot().api.sendMessage.mock.calls[0]?.[1];
      const secondChunk = currentBot().api.sendMessage.mock.calls[1]?.[1];
      expect(firstChunk).toBe('x'.repeat(3499));
      expect(secondChunk).toBe(`${emoji}tail`);
    });

    it('splits 4096-character messages to stay near the soft budget', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'y'.repeat(3500),
        { parse_mode: 'MarkdownV2' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'y'.repeat(596),
        { parse_mode: 'MarkdownV2' },
      );
    });

    it.each([799, 800, 801])(
      'sends %i character messages without splitting',
      async (length) => {
        const opts = createTestOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();
        currentBot().api.sendMessage.mockClear();

        const text = 'z'.repeat(length);
        await channel.sendMessage('tg:100200300', text);

        expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
        expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
          '100200300',
          text,
          { parse_mode: 'MarkdownV2' },
        );
      },
    );

    it('escapes MarkdownV2 text before sending', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello (world)');
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello \\(world\\)',
        { parse_mode: 'MarkdownV2' },
      );
    });

    it.each(['2 * 3', 'snake_case', 'stray ~ marker'])(
      'falls back to plain text when first MarkdownV2 chunk parse fails: %s',
      async (input) => {
        const opts = createTestOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        currentBot()
          .api.sendMessage.mockReset()
          .mockRejectedValueOnce(
            new Error("Bad Request: can't parse entities: parse error"),
          )
          .mockResolvedValueOnce({ message_id: 987 });

        await channel.sendMessage('tg:100200300', input);

        const expectedEscaped = input
          .replaceAll('\\', '\\\\')
          .replaceAll('_', '\\_')
          .replaceAll('*', '\\*')
          .replaceAll('~', '\\~');
        expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
        expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
          1,
          '100200300',
          expectedEscaped,
          { parse_mode: 'MarkdownV2' },
        );
        expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
          2,
          '100200300',
          input,
          {},
        );
      },
    );

    it('falls back to plain text for planned chunks when first MarkdownV2 chunk parse fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const parseError = new Error(
        "Bad Request: can't parse entities: Can't find end of the entity",
      );
      currentBot()
        .api.sendMessage.mockReset()
        .mockRejectedValueOnce(parseError)
        .mockResolvedValueOnce({ message_id: 101 })
        .mockResolvedValueOnce({ message_id: 102 });

      const result = await channel.sendMessage(
        'tg:100200300',
        'x'.repeat(5000),
      );

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(3);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(3500),
        { parse_mode: 'MarkdownV2' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(3500),
        {},
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        3,
        '100200300',
        'x'.repeat(1500),
        {},
      );
      expect(result).toEqual(
        expect.objectContaining({
          deliveredParts: 2,
          totalParts: 2,
          externalMessageIds: ['101', '102'],
          warnings: ['telegram.message.chunked:2:3500'],
        }),
      );
    });

    it('falls back to plain text from chunk 2 onward when a later MarkdownV2 parse fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const parseError = new Error(
        "Bad Request: can't parse entities: Can't find end of the entity",
      );
      const chunkedWithLiteralMarkers = `${'a'.repeat(3600)}snake_case *literal* ~literal~${'b'.repeat(3600)}`;
      currentBot()
        .api.sendMessage.mockReset()
        .mockResolvedValueOnce({ message_id: 201 })
        .mockRejectedValueOnce(parseError)
        .mockResolvedValueOnce({ message_id: 202 })
        .mockResolvedValueOnce({ message_id: 203 });

      const result = await channel.sendMessage(
        'tg:100200300',
        chunkedWithLiteralMarkers,
      );

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(4);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        expect.any(String),
        { parse_mode: 'MarkdownV2' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        expect.any(String),
        { parse_mode: 'MarkdownV2' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        3,
        '100200300',
        expect.not.stringContaining('\\_'),
        {},
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        3,
        '100200300',
        expect.stringContaining('snake_case'),
        {},
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        3,
        '100200300',
        expect.stringContaining('*literal*'),
        {},
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        3,
        '100200300',
        expect.stringContaining('~literal~'),
        {},
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        4,
        '100200300',
        expect.any(String),
        {},
      );
      expect(result).toEqual(
        expect.objectContaining({
          deliveredParts: 3,
          totalParts: 3,
          externalMessageIds: ['201', '202', '203'],
          warnings: ['telegram.message.chunked:3:3500'],
        }),
      );
    });

    it('marks long message failures after an earlier chunk as partial delivery', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const apiError = new Error('Network lost on second chunk');
      currentBot()
        .api.sendMessage.mockReset()
        .mockResolvedValueOnce({ message_id: 1 })
        .mockRejectedValueOnce(apiError)
        .mockRejectedValueOnce(apiError)
        .mockRejectedValueOnce(apiError);

      await expect(
        channel.sendMessage('tg:100200300', 'x'.repeat(5000)),
      ).rejects.toMatchObject({
        name: 'PartialTelegramDeliveryError',
        partialMessageDelivery: true,
        deliveredChunks: 1,
        totalChunks: 2,
        retryTail: {
          canonicalText: 'x'.repeat(1500),
          providerPayload: expect.objectContaining({
            provider: 'telegram',
            chatId: '100200300',
          }),
        },
      });
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('keeps Telegram retry-tail canonical text unescaped for chunked partials', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const apiError = new Error('Network lost on second chunk');
      currentBot()
        .api.sendMessage.mockReset()
        .mockResolvedValueOnce({ message_id: 1 })
        .mockRejectedValueOnce(apiError)
        .mockRejectedValueOnce(apiError)
        .mockRejectedValueOnce(apiError);

      const tail = '_tail_.[]()';
      await expect(
        channel.sendMessage('tg:100200300', `${'x'.repeat(3500)}${tail}`),
      ).rejects.toMatchObject({
        name: 'PartialTelegramDeliveryError',
        partialMessageDelivery: true,
        deliveredChunks: 1,
        totalChunks: 2,
        retryTail: {
          canonicalText: tail,
          providerPayload: expect.objectContaining({
            provider: 'telegram',
            chatId: '100200300',
          }),
        },
      });
    });

    it('rejects when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await expect(
        channel.sendMessage('tg:100200300', 'No bot'),
      ).rejects.toThrow('Telegram bot not initialized');
    });
  });

  describe('sendStreamingChunk', () => {
    it('ignores done=true when no private draft stream is active', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessageDraft.mockClear();
      currentBot().api.sendMessage.mockClear();

      await channel.sendStreamingChunk('tg:100200300', '', { done: true });

      expect(currentBot().api.sendMessageDraft).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
    });

    it('uses sendMessageDraft in private chats and sends final message on done', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendStreamingChunk('tg:100200300', 'Hello ');
      await channel.sendStreamingChunk('tg:100200300', 'world');
      await channel.sendStreamingChunk('tg:100200300', '', { done: true });

      expect(currentBot().api.sendMessageDraft).toHaveBeenCalledWith(
        100200300,
        expect.any(Number),
        expect.stringContaining('Hello'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
      expect(currentBot().api.sendMessage).toHaveBeenLastCalledWith(
        '100200300',
        'Hello world',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });

    it('streams in groups via send+edit fallback', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendStreamingChunk('tg:-1001234567890', 'group update');
      await channel.sendStreamingChunk('tg:-1001234567890', '', { done: true });

      expect(currentBot().api.sendMessageDraft).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'group update',
        {},
      );
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '-1001234567890',
        987,
        'group update',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });

    it('streams in groups even when private draft streaming is unavailable', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      (channel as unknown as { draftStreamApi: null }).draftStreamApi = null;

      const delivered = await channel.sendStreamingChunk(
        'tg:-1001234567890',
        'group update',
        { threadId: '1' },
      );

      expect(delivered).toBe(true);
      expect(currentBot().api.sendMessageDraft).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'group update',
        { message_thread_id: 1 },
      );
    });

    it('does not duplicate final group message when edit returns "message is not modified"', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.editMessageText.mockRejectedValue(
        new Error('Bad Request: message is not modified'),
      );

      await channel.sendStreamingChunk('tg:-1001234567890', 'group update');
      await channel.sendStreamingChunk('tg:-1001234567890', '', { done: true });

      // first chunk creates the stream message; done path should not resend
      // identical content on "message is not modified".
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'group update',
        {},
      );
      expect(currentBot().api.editMessageText).toHaveBeenCalled();
    });

    it('throws partial delivery on final group edit failure after visible head without resending full content', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.editMessageText.mockRejectedValue(
        new Error('Bad Request: failed to edit message'),
      );

      await channel.sendStreamingChunk('tg:-1001234567890', 'group update');
      await expect(
        channel.sendStreamingChunk('tg:-1001234567890', '', { done: true }),
      ).rejects.toMatchObject({
        name: 'PartialTelegramGroupFinalEditDeliveryError',
        partialMessageDelivery: true,
        deliveredChunks: 1,
        totalChunks: 2,
        deliveredParts: 1,
        totalParts: 2,
        externalMessageId: '987',
        externalMessageIds: ['987'],
      });

      // first chunk creates the visible stream message; done path must not
      // resend the whole rendered buffer after final edit failure.
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'group update',
        {},
      );
    });

    it('includes visible Telegram message ids in final group edit retry-tail metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot()
        .api.sendMessage.mockReset()
        .mockResolvedValueOnce({ message_id: 321 })
        .mockRejectedValueOnce(new Error('overflow markdown send failed'))
        .mockRejectedValueOnce(new Error('overflow escaped send failed'))
        .mockRejectedValueOnce(new Error('overflow plain send failed'));
      currentBot().api.editMessageText.mockRejectedValue(
        new Error('Bad Request: failed to edit message'),
      );

      await channel.sendStreamingChunk('tg:-1001234567890', 'x'.repeat(4500));
      await expect(
        channel.sendStreamingChunk('tg:-1001234567890', '', { done: true }),
      ).rejects.toMatchObject({
        name: 'PartialTelegramGroupFinalEditDeliveryError',
        partialMessageDelivery: true,
        deliveredChunks: 1,
        totalChunks: 2,
        deliveredParts: 1,
        totalParts: 2,
        externalMessageId: '321',
        externalMessageIds: ['321'],
        retryTail: {
          canonicalText: 'x'.repeat(1000),
          providerPayload: expect.objectContaining({
            provider: 'telegram',
            chatId: '-1001234567890',
            externalMessageId: '321',
            externalMessageIds: ['321'],
          }),
        },
      });
    });

    it('ignores stale streaming generations for the same chat', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendStreamingChunk('tg:-1001234567890', 'fresh', {
        generation: 2,
      });

      currentBot().api.sendMessage.mockClear();
      currentBot().api.editMessageText.mockClear();

      await channel.sendStreamingChunk('tg:-1001234567890', 'stale', {
        generation: 1,
      });

      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();
    });

    it('seals previous generation on resetStreaming to reject late stale chunks', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendStreamingChunk('tg:-1001234567890', 'old', {
        generation: 1,
      });

      channel.resetStreaming('tg:-1001234567890');
      currentBot().api.sendMessage.mockClear();
      currentBot().api.editMessageText.mockClear();

      await channel.sendStreamingChunk('tg:-1001234567890', 'stale', {
        generation: 1,
      });

      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();

      await channel.sendStreamingChunk('tg:-1001234567890', 'fresh', {
        generation: 2,
      });

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'fresh',
        {},
      );
    });
  });

  describe('sendProgressUpdate', () => {
    it('sends first progress message then edits it on updates', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const stopAction = {
        actionAffordances: [
          {
            kind: 'live_turn_stop' as const,
            label: 'Stop',
            actionToken: 'token-1',
          },
        ],
      };
      await channel.sendProgressUpdate(
        'tg:-1001234567890',
        'Working on it...',
        stopAction,
      );
      await channel.sendProgressUpdate(
        'tg:-1001234567890',
        'Still working (1m 00s)...',
        stopAction,
      );

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Working on it...',
        expect.objectContaining({
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Stop', callback_data: 'lt:stop:token-1' }],
            ],
          },
        }),
      );
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '-1001234567890',
        987,
        'Still working (1m 00s)...',
        expect.objectContaining({
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Stop', callback_data: 'lt:stop:token-1' }],
            ],
          },
        }),
      );
    });

    it('clears progress state on done and starts a fresh message next run', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...');
      await channel.sendProgressUpdate('tg:100200300', 'Done in 10s.', {
        done: true,
      });

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'Working on it...',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
      expect(currentBot().api.editMessageText).toHaveBeenCalledTimes(1);
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        987,
        'Done in 10s.',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );

      currentBot().api.sendMessage.mockClear();
      currentBot().api.editMessageText.mockClear();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...');

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();
    });

    it('drops stale progress updates after a generation is done', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...', {
        generation: 1,
      });
      await channel.sendProgressUpdate('tg:100200300', 'Done in 10s.', {
        done: true,
        generation: 1,
      });

      currentBot().api.sendMessage.mockClear();
      currentBot().api.editMessageText.mockClear();

      await channel.sendProgressUpdate('tg:100200300', 'Still working...', {
        generation: 1,
      });

      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();
    });

    it('refreshes a stale unchanged initial progress handle with a new message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...', {
        generation: 1,
      });
      currentBot().api.sendMessage.mockClear();
      currentBot().api.editMessageText.mockClear();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...', {
        generation: 1,
      });

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();
    });

    it('does not create a progress message for replace-only updates', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Done in 1s.', {
        done: true,
        replaceOnly: true,
      });

      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();
    });

    it('edits and clears an existing progress message for replace-only done', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...', {
        actionAffordances: [
          {
            kind: 'live_turn_stop',
            label: 'Stop',
            actionToken: 'token-1',
          },
        ],
      });
      await channel.sendProgressUpdate('tg:100200300', 'Done in 1s.', {
        done: true,
        replaceOnly: true,
      });
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        987,
        'Done in 1s.',
        expect.objectContaining({
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [] },
        }),
      );
      currentBot().api.sendMessage.mockClear();
      currentBot().api.editMessageText.mockClear();

      await channel.sendProgressUpdate('tg:100200300', 'Done in 2s.', {
        done: true,
        replaceOnly: true,
      });

      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();
    });

    it('starts a fresh progress handle when generation changes under the same chat key', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...', {
        generation: 1,
      });
      await channel.sendProgressUpdate('tg:100200300', 'Working on it...', {
        generation: 2,
      });

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();

      await channel.sendProgressUpdate('tg:100200300', 'Done in old turn.', {
        done: true,
        replaceOnly: true,
        generation: 1,
      });
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();

      await channel.sendProgressUpdate('tg:100200300', 'Done in new turn.', {
        done: true,
        replaceOnly: true,
        generation: 3,
      });
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        987,
        'Done in new turn.',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });

    it('restores progress handles after process restart', async () => {
      const runtimeHome = fs.mkdtempSync('/tmp/gantry-tg-progress-');
      const savedHome = process.env.GANTRY_HOME;
      process.env.GANTRY_HOME = runtimeHome;
      try {
        const first = new TelegramChannel('test-token', createTestOpts());
        await first.connect();
        await first.sendProgressUpdate('tg:100200300', 'Working on it...');

        const second = new TelegramChannel('test-token', createTestOpts());
        await second.connect();
        currentBot().api.sendMessage.mockClear();
        await second.sendProgressUpdate('tg:100200300', 'Done in 1s.', {
          done: true,
          replaceOnly: true,
        });

        expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
        expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
          '100200300',
          987,
          'Done in 1s.',
          expect.objectContaining({ parse_mode: 'MarkdownV2' }),
        );
      } finally {
        if (savedHome === undefined) delete process.env.GANTRY_HOME;
        else process.env.GANTRY_HOME = savedHome;
        fs.rmSync(runtimeHome, { recursive: true, force: true });
      }
    });

    it('falls back to a new progress message when edit fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...');
      currentBot().api.editMessageText.mockRejectedValue(
        new Error('message can not be edited'),
      );

      await channel.sendProgressUpdate('tg:100200300', 'Still working...');

      expect(currentBot().api.editMessageText).toHaveBeenCalled();
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenLastCalledWith(
        '100200300',
        'Still working...',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  describe('permission approvals', () => {
    it('renders Bash command summary when permission request includes toolInput', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-command',
          sourceAgentFolder: 'whatsapp_main',
          targetJid: 'tg:100200300',
          threadId: '42',
          toolName: 'Bash',
          toolInput: {
            command: 'rm -rf /tmp/old-cache && npm install',
          },
        },
      );
      await flushPromises();

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        expect.stringContaining('Approval applies to the parent conversation.'),
        expect.objectContaining({ message_thread_id: 42 }),
      );
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        expect.stringContaining(
          'Command:\n<pre>rm -rf /tmp/old-cache &amp;&amp; npm install</pre>',
        ),
        expect.objectContaining({ message_thread_id: 42, parse_mode: 'HTML' }),
      );

      const callbackCtx = {
        callbackQuery: { data: 'perm:allow_once:perm-command' },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(callbackCtx);
      await decisionPromise;
    });

    it('falls back to a plain-text permission prompt when the HTML send is rejected', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      // First (HTML) send is rejected; the fallback resends as plain text.
      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error("Bad Request: can't parse entities"),
      );

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-fb',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Bash',
          toolInput: { command: 'npm test' },
        },
      );
      await flushPromises();

      const calls = currentBot().api.sendMessage.mock.calls;
      expect(calls[0][2]).toMatchObject({ parse_mode: 'HTML' });
      // The plain-text retry must NOT set parse_mode, and must still carry the
      // decision buttons + the readable prompt so the approval stays actionable.
      expect(calls[1][2]).not.toHaveProperty('parse_mode');
      expect(calls[1][2].reply_markup.inline_keyboard.length).toBeGreaterThan(
        0,
      );
      expect(calls[1][1]).toContain(
        '🔐 Allow Whatsapp Main to use exact command access?',
      );

      await triggerCallbackQuery({
        callbackQuery: { data: 'perm:allow_once:perm-fb' },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      const decision = await decisionPromise;
      expect(decision.approved).toBe(true);
    });

    it('splits oversized permission review text before sending the decision buttons', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const tail = 'review-tail-after-shared-budget';
      const proposed = `${'x'.repeat(7000)}${tail}`;

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-profile-large',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'request_agent_profile_update',
          title: 'Update AGENTS.md',
          interaction: {
            id: 'perm-profile-large',
            title: 'Update AGENTS.md',
            body: 's'.repeat(2000),
            requestContext: {
              requestId: 'perm-profile-large',
              sourceAgentFolder: 'whatsapp_main',
              targetJid: 'tg:100200300',
              toolName: 'request_agent_profile_update',
            },
            files: [
              {
                path: 'AGENTS.md',
                preview: proposed,
                truncated: false,
                sizeBytes: proposed.length,
                contentHash: 'abc123',
              },
            ],
          },
        },
      );
      await flushPromises();

      const calls = currentBot().api.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      const reviewCalls = calls.slice(0, -1);
      const finalCall = calls.at(-1);
      for (const call of reviewCalls) {
        expect(call[1].length).toBeLessThanOrEqual(4096);
        expect(call[2]).not.toHaveProperty('reply_markup');
        expect(call[2]).not.toHaveProperty('parse_mode');
      }
      expect(reviewCalls.map((call) => call[1]).join('')).toContain(tail);
      expect(finalCall?.[1]).toContain(
        'Review the approval details above before choosing.',
      );
      expect(finalCall?.[2]).toMatchObject({
        parse_mode: 'HTML',
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array),
        }),
      });

      await triggerCallbackQuery({
        callbackQuery: { data: 'perm:allow_once:perm-profile-large' },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      const decision = await decisionPromise;
      expect(decision.approved).toBe(true);
    });

    it('sends approval prompt and resolves when an admin approves', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId:
            'capability-request_permission-0faf53fe-39cd-4ef0-af6e-5e09b96eef53',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Bash',
          title: 'Allow command',
        },
      );
      await flushPromises();

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        expect.stringContaining(
          '🔐 Allow Whatsapp Main to use exact command access?',
        ),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
      const sendOptions = currentBot().api.sendMessage.mock.calls.at(-1)?.[2];
      const callbackData =
        sendOptions.reply_markup.inline_keyboard[0][0].callback_data;
      expect(callbackData).toMatch(/^perm:allow_once:p[0-9a-z]+$/);
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);

      const callbackCtx = {
        callbackQuery: { data: callbackData },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(callbackCtx);
      const decision = await decisionPromise;

      expect(decision).toEqual({
        approved: true,
        decidedBy: 'Ravi',
        mode: 'allow_once',
        decisionClassification: 'user_temporary',
        reason: 'allowed once via Telegram',
      });
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Allowed once. Details posted in chat.',
      });
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        987,
        expect.stringContaining(
          'Allowed once: Allow command. The agent will continue this request.',
        ),
        expect.objectContaining({
          reply_markup: { inline_keyboard: [] },
        }),
      );
    });

    it('rejects non-admin callbacks and keeps the request pending', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-2',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Write',
        },
      );
      await flushPromises();

      const deniedCtx = {
        callbackQuery: { data: 'perm:allow_once:perm-2' },
        chat: { id: 100200300 },
        from: { id: 111, first_name: 'Visitor' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(deniedCtx);
      expect(deniedCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Only a conversation control approver can approve.',
        show_alert: true,
      });

      const approvedCtx = {
        callbackQuery: { data: 'perm:allow_once:perm-2' },
        chat: { id: 100200300 },
        from: { id: 444, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(approvedCtx);
      const decision = await decisionPromise;
      expect(decision.approved).toBe(true);
      expect(decision.decidedBy).toBe('Admin');
    });

    it('requires the source group control allowlist from settings.yaml', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-settings',
          sourceAgentFolder: 'unlisted_source',
          decisionPolicy: 'same_channel',
          toolName: 'Write',
        },
      );
      await flushPromises();

      const deniedCtx = {
        callbackQuery: { data: 'perm:allow_once:perm-settings' },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'EnvOnly' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(deniedCtx);

      expect(deniedCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Only a conversation control approver can approve.',
        show_alert: true,
      });

      await channel.disconnect();
      await expect(decisionPromise).resolves.toEqual(
        expect.objectContaining({
          approved: false,
          reason: 'Telegram channel disconnected',
        }),
      );
    });

    it('auto-denies approval request after timeout', async () => {
      vi.useFakeTimers();
      try {
        const opts = createTestOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const decisionPromise = channel.requestPermissionApproval(
          'tg:100200300',
          {
            requestId: 'perm-timeout',
            sourceAgentFolder: 'whatsapp_main',
            toolName: 'Edit',
          },
        );
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(300_000);
        const decision = await decisionPromise;
        expect(decision).toEqual({
          approved: false,
          decidedBy: 'system',
          reason: 'timed out',
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('user question prompts', () => {
    it('uses numbered byte-safe button labels for long options', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      currentBot().api.sendMessage.mockClear();

      const longOptionA =
        '🚀 '.repeat(30) + 'Staging rollout with extra descriptive text';
      const longOptionB =
        '🧪 '.repeat(30) + 'Production rollout with extra descriptive text';

      const responsePromise = channel.requestUserAnswer('tg:100200300', {
        requestId: 'userq-long',
        sourceAgentFolder: 'whatsapp_main',
        threadId: '99abc',
        questions: [
          {
            question: 'Where should we deploy?',
            header: 'Deploy',
            options: [
              { label: longOptionA, description: 'Option A description' },
              { label: longOptionB, description: 'Option B description' },
            ],
            multiSelect: false,
          },
        ],
      });
      await flushPromises();

      const firstCall = currentBot().api.sendMessage.mock.calls[0];
      expect(firstCall[1]).toContain('❓ Deploy');
      expect(firstCall[1]).toContain('Where should we deploy?');
      expect(firstCall[1]).not.toContain('Source: whatsapp_main');
      expect(firstCall[1]).not.toContain('Thread: 99abc');
      expect(firstCall[2]).not.toHaveProperty('message_thread_id');
      const replyMarkup = firstCall[2].reply_markup;
      const keyboard = replyMarkup.inline_keyboard as Array<
        Array<{ text: string }>
      >;
      const optionButtonTexts = keyboard.slice(0, 2).map((row) => row[0].text);

      expect(optionButtonTexts[0]).toMatch(/^1\. /);
      expect(optionButtonTexts[1]).toMatch(/^2\. /);
      optionButtonTexts.forEach((text) => {
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(56);
      });

      await triggerCallbackQuery({
        callbackQuery: { data: 'userq:select:userq-long:0:0' },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      const response = await responsePromise;
      expect(response.answers['Where should we deploy?']).toBe(longOptionA);
    });

    it('resolves single-select question from callback selection', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const responsePromise = channel.requestUserAnswer('tg:100200300', {
        requestId: 'userq-1',
        sourceAgentFolder: 'whatsapp_main',
        threadId: '77',
        questions: [
          {
            question: 'Which environment should we deploy to?',
            header: 'Deploy',
            options: [
              { label: 'Staging', description: 'Safer first' },
              { label: 'Production', description: 'Go live now' },
            ],
            multiSelect: false,
          },
        ],
      });
      await flushPromises();

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        expect.stringContaining('Which environment should we deploy to?'),
        expect.objectContaining({
          message_thread_id: 77,
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );

      const callbackCtx = {
        callbackQuery: { data: 'userq:select:userq-1:0:1' },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(callbackCtx);

      const response = await responsePromise;
      expect(response).toEqual({
        requestId: 'userq-1',
        answers: {
          'Which environment should we deploy to?': 'Production',
        },
        answeredBy: 'Ravi',
      });
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Saved.',
      });
    });

    it('rejects non-admin user-question callbacks and keeps the prompt pending', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const responsePromise = channel.requestUserAnswer('tg:100200300', {
        requestId: 'userq-auth',
        sourceAgentFolder: 'whatsapp_main',
        questions: [
          {
            question: 'Approve rollout?',
            header: 'Rollout',
            options: [
              { label: 'Yes', description: 'Proceed' },
              { label: 'No', description: 'Stop' },
            ],
            multiSelect: false,
          },
        ],
      });
      await flushPromises();

      const deniedCtx = {
        callbackQuery: { data: 'userq:select:userq-auth:0:0' },
        chat: { id: 100200300 },
        from: { id: 111, first_name: 'Visitor' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(deniedCtx);
      expect(deniedCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Only a conversation control approver can answer.',
        show_alert: true,
      });

      const approvedCtx = {
        callbackQuery: { data: 'userq:select:userq-auth:0:1' },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(approvedCtx);

      const response = await responsePromise;
      expect(response.answers['Approve rollout?']).toBe('No');
      expect(response.answeredBy).toBe('Admin');
    });

    it('consumes unauthorized Other replies without normal message ingress', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const responsePromise = channel.requestUserAnswer('tg:100200300', {
        requestId: 'userq-other-auth',
        sourceAgentFolder: 'whatsapp_main',
        questions: [
          {
            question: 'What should we tell the customer?',
            header: 'Reply',
            options: [{ label: 'Use template', description: 'Default reply' }],
            multiSelect: false,
          },
        ],
      });
      await flushPromises();

      await triggerCallbackQuery({
        callbackQuery: { data: 'userq:other:userq-other-auth:0' },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        api: currentBot().api,
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });

      currentBot().api.sendMessage.mockClear();
      await triggerTextMessage(
        createTextCtx({
          text: 'malicious normal message',
          fromId: 111,
          firstName: 'Visitor',
          messageId: 1000,
          reply_to_message: {
            message_id: 987,
            text: 'Reply to this message with your answer.',
          },
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Only a conversation control approver can answer.',
      );

      await triggerTextMessage(
        createTextCtx({
          text: 'Use the custom account update.',
          fromId: 222,
          firstName: 'Admin',
          messageId: 1001,
          reply_to_message: {
            message_id: 987,
            text: 'Reply to this message with your answer.',
          },
        }),
      );

      const response = await responsePromise;
      expect(response.answers['What should we tell the customer?']).toBe(
        'Use the custom account update.',
      );
      expect(response.answeredBy).toBe('Admin');
    });

    it('resolves durable Other replies after pending prompt memory is gone', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const pending = {
        id: 'pending-question-telegram-other',
        appId: 'default',
        runId: null,
        kind: 'question',
        status: 'pending',
        payload: {
          sourceAgentFolder: 'whatsapp_main',
          requestId: 'userq-durable-other',
          targetJid: 'tg:100200300',
          request: {
            requestId: 'userq-durable-other',
            sourceAgentFolder: 'whatsapp_main',
            questions: [
              {
                question: 'What should we tell the customer?',
                header: 'Reply',
                options: [
                  { label: 'Use template', description: 'Default reply' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        callbackRoute: null,
        idempotencyKey: 'question:whatsapp_main:userq-durable-other',
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
      configurePendingInteractionDurability({
        repository: repository as never,
      });

      const callbackCtx = {
        callbackQuery: {
          data: 'userq:other:userq-durable-other:0',
          message: { chat: { id: 100200300 }, message_thread_id: 77 },
        },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        api: currentBot().api,
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(callbackCtx);

      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Reply with your answer.',
      });
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Reply to this message with your answer.',
        expect.objectContaining({
          message_thread_id: 77,
          reply_markup: expect.objectContaining({ force_reply: true }),
        }),
      );

      currentBot().api.sendMessage.mockClear();
      await triggerTextMessage(
        createTextCtx({
          text: 'Use the custom account update.',
          fromId: 222,
          firstName: 'Admin',
          messageId: 1001,
          reply_to_message: {
            message_id: 987,
            text: 'Reply to this message with your answer.',
          },
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(repository.resolvePendingInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: 'question:whatsapp_main:userq-durable-other',
          status: 'resolved',
          resolution: {
            answers: {
              'What should we tell the customer?':
                'Use the custom account update.',
            },
          },
          approverRef: 'Admin',
        }),
      );
      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
    });

    it('resolves multi-select question when Done is pressed', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const responsePromise = channel.requestUserAnswer('tg:100200300', {
        requestId: 'userq-2',
        sourceAgentFolder: 'whatsapp_main',
        questions: [
          {
            question: 'Which checks should we run?',
            header: 'Checks',
            options: [
              { label: 'Build', description: 'Compile project' },
              { label: 'Unit tests', description: 'Fast tests' },
              { label: 'Integration', description: 'End-to-end tests' },
            ],
            multiSelect: true,
          },
        ],
      });
      await flushPromises();

      await triggerCallbackQuery({
        callbackQuery: { data: 'userq:select:userq-2:0:0' },
        chat: { id: 100200300 },
        from: { id: 333, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await triggerCallbackQuery({
        callbackQuery: { data: 'userq:select:userq-2:0:2' },
        chat: { id: 100200300 },
        from: { id: 333, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await triggerCallbackQuery({
        callbackQuery: { data: 'userq:done:userq-2:0' },
        chat: { id: 100200300 },
        from: { id: 333, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });

      const response = await responsePromise;
      expect(response).toEqual({
        requestId: 'userq-2',
        answers: {
          'Which checks should we run?': ['Build', 'Integration'],
        },
        answeredBy: 'Ravi',
      });
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- bot.catch error handler (line 393) ---

  describe('bot.catch error handler', () => {
    it('invokes errorHandler and logs the error message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const errorHandler = currentBot().errorHandler!;
      expect(errorHandler).not.toBeNull();

      // Invoke the error handler as grammy would
      errorHandler({ message: 'Polling error occurred' });

      const { logger: mockLogger } =
        await import('@core/infrastructure/logging/logger.js');
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: 'Polling error occurred' },
        'Telegram bot error',
      );
    });

    it('authorizes permission callbacks through conversation approver hook', async () => {
      const isControlApproverAllowed = vi.fn(async () => true);
      const opts = createTestOpts({ isControlApproverAllowed });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const decisionPromise = channel.requestPermissionApproval('tg:777', {
        requestId: 'perm-channel-allowlist',
        sourceAgentFolder: 'unlisted_source',
        approvalContextJid: 'tg:100200300',
        decisionPolicy: 'same_channel',
        toolName: 'Write',
      });
      await flushPromises();

      const approvedCtx = {
        callbackQuery: {
          data: 'perm:allow_once:perm-channel-allowlist',
          from: { id: 777, first_name: 'ChannelAdmin' },
          message: { chat: { id: 777 } },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(approvedCtx);
      const decision = await decisionPromise;

      expect(isControlApproverAllowed).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'telegram',
          conversationJid: 'tg:100200300',
          userId: '777',
        }),
      );
      expect(decision).toEqual(
        expect.objectContaining({
          approved: true,
          decidedBy: 'ChannelAdmin',
        }),
      );
    });
  });

  // --- sendMessage outer catch ---

  describe('sendMessage outer catch', () => {
    it('logs error when Telegram message send fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Reject ALL calls to sendMessage so the outer catch fires
      const apiError = new Error('Chat not found');
      currentBot().api.sendMessage.mockRejectedValue(apiError);

      await expect(
        channel.sendMessage('tg:100200300', 'This will fail'),
      ).rejects.toThrow('Chat not found');

      const { logger: mockLogger } =
        await import('@core/infrastructure/logging/logger.js');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300' }),
        'Failed to send Telegram message',
      );
    });
  });
});

describe('createTelegramChannel factory', () => {
  it('returns null when TELEGRAM_BOT_TOKEN is not set', () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const result = createTelegramChannel({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        conversationRoutes: () => ({}),
      });
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Telegram: TELEGRAM_BOT_TOKEN not set',
      );
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });

  it('returns a TelegramChannel when token is available', () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-from-env';
    try {
      const result = createTelegramChannel({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        conversationRoutes: () => ({}),
      });
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(TelegramChannel);
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });
});
