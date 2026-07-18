import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('@core/config/index.js', () => ({
  ASSISTANT_NAME: 'Andy',
  PERMISSION_APPROVAL_TIMEOUT_MS: 300000,
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
  withLogContext: (_context: unknown, callback: () => unknown) => callback(),
  updateLogContext: vi.fn(),
}));

// Mock workspace-folder (used by downloadFile)
vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

const telegramPromptBindingBehavior = vi.hoisted(() => ({
  strict: false,
  interactions: [] as any[],
}));

vi.mock('@core/channels/telegram/prompt-binding.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@core/channels/telegram/prompt-binding.js')
    >();
  return {
    ...actual,
    bindTelegramPermission: vi.fn(async (...args: never[]) => {
      const request = args[0] as unknown as {
        appId?: string;
        sourceAgentFolder: string;
        requestId: string;
      };
      const appId = request.appId || 'default';
      const idempotencyKey = `${appId}:permission:${request.sourceAgentFolder}:${request.requestId}`;
      if (
        !telegramPromptBindingBehavior.interactions.some(
          (interaction) => interaction.idempotencyKey === idempotencyKey,
        )
      ) {
        telegramPromptBindingBehavior.interactions.push({
          id: `pending-${request.sourceAgentFolder}-${request.requestId}`,
          appId,
          runId: 'run-1',
          kind: 'permission',
          status: 'pending',
          payload: {
            requestId: request.requestId,
            sourceAgentFolder: request.sourceAgentFolder,
            request,
          },
          idempotencyKey,
        });
      }
      const bound = await actual.bindTelegramPermission(...args);
      return bound || !telegramPromptBindingBehavior.strict;
    }),
    bindTelegramQuestionCallback: vi.fn(async (...args: never[]) => {
      const request =
        args[0] as unknown as import('@core/domain/types.js').UserQuestionRequest;
      const appId = request.appId || 'default';
      const idempotencyKey = `${appId}:question:${request.sourceAgentFolder}:${request.requestId}`;
      let interaction = telegramPromptBindingBehavior.interactions.find(
        (candidate) => candidate.idempotencyKey === idempotencyKey,
      );
      if (!interaction) {
        interaction = {
          appId,
          kind: 'question',
          status: 'pending',
          idempotencyKey,
          payload: {
            requestId: request.requestId,
            sourceAgentFolder: request.sourceAgentFolder,
            request,
            questionRecoveryEnvelope: {
              version: 1,
              targetJid: request.targetJid ?? 'tg:100200300',
              threadId: request.threadId ?? null,
              request,
              callbacks: {},
              selections: [],
              answers: {},
              completedQuestionIndexes: [],
              deliveredQuestionIndexes: [],
              otherPrompts: {},
            },
          },
        };
        telegramPromptBindingBehavior.interactions.push(interaction);
      }
      try {
        await actual.bindTelegramQuestionCallback(...args);
      } catch (err) {
        if (telegramPromptBindingBehavior.strict) throw err;
      }
    }),
  };
});

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  InputFile: class MockInputFile {
    constructor(
      readonly data: unknown,
      readonly filename?: string,
    ) {}
  },
  Bot: class MockBot {
    token: string;
    pollingRunning = false;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 987 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 988 }),
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
      getChat: vi.fn().mockResolvedValue({ title: 'Ops Room' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
      setMessageReaction: vi.fn().mockResolvedValue(true),
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
import { EnvRuntimeSecretProvider } from '@core/adapters/credentials/env-runtime-secret-provider.js';
import {
  createTelegramChannel,
  TelegramChannel,
  TelegramChannelOpts,
} from '@core/channels/telegram/channel-adapter.js';
import {
  configurePendingInteractionDurability,
  configurePermissionReviewEachDispatcher,
} from '@core/application/interactions/pending-interaction-durability.js';
import { writeTelegramFetchResponseToFile } from '@core/channels/telegram-file-download.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { createPermissionBatchRequest } from '@core/channels/permission-batch-coalescer.js';
import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
import { telegramQuestionCallbackId } from '@core/channels/telegram/channel-shared.js';
import type {
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
  PermissionCallbackScope,
} from '@core/domain/types.js';
import type {
  GroupJoinOnboardingCoordinator,
  GroupJoinOnboardingRecord,
} from '@core/domain/ports/group-join-onboarding.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    providerAccountId: 'telegram_default',
    conversationRoutes: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        providerAccountId: 'telegram_default',
      },
    })),
    runtimeSettings: vi.fn(() => ({
      providers: {
        telegram: { enabled: true },
      },
      providerAccounts: {
        telegram_default: {
          agentId: 'whatsapp_main',
          provider: 'telegram',
          label: 'Telegram',
          runtimeSecretRefs: {
            bot_token: 'env:TELEGRAM_BOT_TOKEN',
          },
        },
      },
      conversations: {
        whatsapp_main_conversation: {
          providerConnection: 'telegram_default',
          providerAccount: 'telegram_default',
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

function createTelegramGroupApprovalOpts(): TelegramChannelOpts {
  const base = createTestOpts();
  const settings = base.runtimeSettings!();
  return createTestOpts({
    runtimeSettings: vi.fn(() => ({
      ...settings,
      conversations: {
        ...settings.conversations,
        whatsapp_main_conversation: {
          ...settings.conversations.whatsapp_main_conversation,
          externalId: '-100200300',
        },
      },
    })),
  });
}

function createGroupJoinOnboardingOpts() {
  const base = createTestOpts();
  const settings = base.runtimeSettings!();
  let currentRecord: GroupJoinOnboardingRecord | null = null;
  let nextId = 1;
  const timestamp = '2026-07-18T00:00:00.000Z';
  const coordinator: GroupJoinOnboardingCoordinator = {
    recordPrompt: vi.fn(async (input) => {
      if (currentRecord?.status === 'registered') return currentRecord;
      currentRecord = {
        id: `join-${nextId++}`,
        ...input,
        status: 'prompted',
        promptedAt: timestamp,
        dismissedAt: null,
        registeredAt: null,
        leftAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return currentRecord;
    }),
    getById: vi.fn(async (id) =>
      currentRecord?.id === id ? currentRecord : null,
    ),
    dismiss: vi.fn(async (id) => {
      if (currentRecord?.id !== id || currentRecord.status !== 'prompted') {
        return null;
      }
      currentRecord = {
        ...currentRecord,
        status: 'dismissed',
        dismissedAt: timestamp,
      };
      return currentRecord;
    }),
    register: vi.fn(async ({ id }) => {
      if (currentRecord?.id !== id || currentRecord.status !== 'prompted') {
        return null;
      }
      currentRecord = {
        ...currentRecord,
        status: 'registered',
        registeredAt: timestamp,
      };
      return currentRecord;
    }),
    markLeft: vi.fn(async ({ providerAccountId, chatJid }) => {
      if (
        currentRecord?.providerAccountId !== providerAccountId ||
        currentRecord.chatJid !== chatJid
      ) {
        return null;
      }
      currentRecord = { ...currentRecord, leftAt: timestamp };
      return currentRecord;
    }),
  };
  const opts = createTestOpts({
    conversationRoutes: vi.fn(() => ({
      'tg:100200300': {
        name: 'Known Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: timestamp,
        providerAccountId: 'telegram_default',
      },
      'tg:222': {
        name: 'Operator DM',
        folder: 'whatsapp_main',
        trigger: '@Andy',
        added_at: timestamp,
        providerAccountId: 'telegram_default',
      },
    })),
    runtimeSettings: vi.fn(() => ({
      ...settings,
      conversations: {
        ...settings.conversations,
        whatsapp_main_conversation: {
          ...settings.conversations.whatsapp_main_conversation,
          controlApprovers: ['111'],
        },
        operator_dm: {
          providerConnection: 'telegram_default',
          providerAccount: 'telegram_default',
          externalId: '222',
          kind: 'dm',
          displayName: 'Operator',
          senderPolicy: { allow: '*', mode: 'trigger' },
          controlApprovers: ['222'],
          installedAgents: {},
        },
      },
    })),
    groupJoinOnboarding: coordinator,
    isControlApproverAllowed: vi.fn(async (input) =>
      Boolean(
        (input.conversationJid === 'tg:100200300' &&
          input.userId === '111' &&
          input.sourceAgentFolder === 'test-group') ||
        (input.conversationJid === 'tg:222' &&
          input.userId === '222' &&
          input.sourceAgentFolder === 'whatsapp_main'),
      ),
    ),
  });
  return {
    opts,
    coordinator,
    getRecord: () => currentRecord,
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
  messageThreadId?: number;
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
      message_thread_id: overrides.messageThreadId,
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

function createMyChatMemberCtx(overrides: {
  chatId?: number;
  title?: string;
  fromId?: number;
  username?: string;
  oldStatus?: string;
  newStatus?: string;
  newMember?: { status: string; is_member?: boolean };
}) {
  const chat = {
    id: overrides.chatId ?? -1001234,
    type: 'supergroup',
    title: overrides.title ?? 'Ops Room',
  };
  const from = {
    id: overrides.fromId ?? 111,
    first_name: 'Bob',
    username: overrides.username ?? 'bob',
  };
  return {
    chat,
    from,
    me: { username: 'andy_ai_bot' },
    api: currentBot().api,
    myChatMember: {
      chat,
      from,
      date: 1_752_800_000,
      old_chat_member: { status: overrides.oldStatus ?? 'left' },
      new_chat_member: overrides.newMember ?? {
        status: overrides.newStatus ?? 'member',
      },
    },
  };
}

function currentBot() {
  return botRef.current;
}

function latestTelegramUserQuestionCallbackData(
  action: 'select' | 'done' | 'other',
  optionIndex?: number,
): string {
  const keyboard = currentBot().api.sendMessage.mock.calls.at(-1)?.[2]
    ?.reply_markup?.inline_keyboard as
    | Array<Array<{ callback_data?: string }>>
    | undefined;
  const callbackData = keyboard
    ?.flat()
    .map((button) => button.callback_data)
    .find(
      (value) =>
        value?.startsWith(`userq:${action}:`) &&
        (optionIndex === undefined || value.endsWith(`:${optionIndex}`)),
    );
  if (!callbackData) throw new Error(`Missing Telegram ${action} callback`);
  return callbackData;
}

function latestPermissionCallback(label: string): string {
  const buttons = currentBot()
    .api.sendMessage.mock.calls.at(-1)?.[2]
    .reply_markup.inline_keyboard.flat();
  return buttons.find((button: { text: string }) => button.text === label)
    .callback_data;
}

function latestGroupJoinCallback(action: 'yes' | 'no'): string {
  const buttons = currentBot()
    .api.sendMessage.mock.calls.at(-1)?.[2]
    ?.reply_markup?.inline_keyboard.flat() as
    | Array<{ callback_data?: string }>
    | undefined;
  const callback = buttons?.find((button) =>
    button.callback_data?.startsWith(`gjoin:${action}:`),
  )?.callback_data;
  if (!callback)
    throw new Error(`Missing Telegram group-join ${action} callback`);
  return callback;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMyChatMember(
  ctx: ReturnType<typeof createMyChatMemberCtx>,
) {
  const handlers = currentBot().filterHandlers.get('my_chat_member') || [];
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
    message?: {
      chat?: { id: number };
      message_id?: number;
      message_thread_id?: number;
    };
  };
  chat?: { id: number };
  from?: { id: number; first_name?: string; username?: string };
  api?: any;
  me?: { username?: string };
  answerCallbackQuery: ReturnType<typeof vi.fn>;
}) {
  const handlers = currentBot().filterHandlers.get('callback_query:data') || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

// Helper: flush pending microtasks (for async downloadFile().then() chains)
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

function permissionClaimRepository(
  interactions: Array<{
    appId: string;
    payload: Record<string, unknown>;
  }>,
) {
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
  return {
    findPendingPermissionInteractions: vi.fn(
      async ({ scope }: { scope: PermissionCallbackScope }) => find(scope),
    ),
    claimPendingPermissionCallback: vi.fn(
      async ({ claim }: { claim: PermissionCallbackClaim }) => {
        const claimed = find(claim.scope).filter((interaction) => {
          if (interaction.payload.permissionCallbackClaim) return false;
          if (
            claim.match.providerAliases[0] &&
            interaction.payload.permissionCallbackId !==
              claim.match.providerAliases[0]
          ) {
            return false;
          }
          return claim.match.kind === 'batch'
            ? interaction.payload.permissionBatchCallbackId ===
                claim.scope.interactionId
            : interaction.payload.requestId === claim.scope.interactionId &&
                !interaction.payload.permissionBatchCallbackId;
        });
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
          if (stored.match.providerAliases[0]) {
            interaction.payload.permissionCallbackId =
              stored.match.providerAliases[0];
          }
          released += 1;
        }
        return released;
      },
    ),
    settlePendingPermissionCallback: vi.fn(
      async ({ claim }: { claim: PermissionCallbackClaimReference }) => {
        let settled = 0;
        for (const interaction of find(claim.scope)) {
          const stored = interaction.payload.permissionCallbackClaim as
            | PermissionCallbackClaim
            | undefined;
          if (stored?.id !== claim.id) continue;
          delete interaction.payload.permissionCallbackClaim;
          settled += 1;
        }
        return settled;
      },
    ),
  };
}

async function updatePendingInteractionPayload(
  interactions: Array<{
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }>,
  input: {
    idempotencyKey: string;
    update: (
      payload: Record<string, unknown>,
    ) => Record<string, unknown> | null;
  },
): Promise<boolean> {
  const interaction = interactions.find(
    (candidate) => candidate.idempotencyKey === input.idempotencyKey,
  );
  if (!interaction) return false;
  const payload = input.update(interaction.payload);
  if (!payload) return false;
  interaction.payload = payload;
  return true;
}

describe('TelegramChannel', () => {
  let savedGantryHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    configurePermissionReviewEachDispatcher(null);
    telegramPromptBindingBehavior.strict = false;
    telegramPromptBindingBehavior.interactions.length = 0;
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
    configurePendingInteractionDurability({
      repository: {
        ...permissionClaimRepository(
          telegramPromptBindingBehavior.interactions,
        ),
        listPendingInteractions: vi.fn(
          async () => telegramPromptBindingBehavior.interactions,
        ),
        updatePendingInteractionPayload: vi.fn((input) =>
          updatePendingInteractionPayload(
            telegramPromptBindingBehavior.interactions,
            input,
          ),
        ),
      } as never,
    });
  });

  afterEach(() => {
    configurePermissionReviewEachDispatcher(null);
    configurePendingInteractionDurability(null);
    if (savedGantryHome === undefined) delete process.env.GANTRY_HOME;
    else process.env.GANTRY_HOME = savedGantryHome;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not expose a conversation context hydration hook', () => {
    const channel = new TelegramChannel('token', createTestOpts());

    expect('hydrateConversationContext' in channel).toBe(false);
  });

  it('adds Telegram reactions idempotently', async () => {
    const channel = new TelegramChannel('token', createTestOpts());
    await channel.connect({ inbound: false });

    await channel.addReaction('tg:100200300', '987', 'running');
    await channel.addReaction('tg:100200300', '987', 'running');

    expect(botRef.current.api.setMessageReaction).toHaveBeenCalledTimes(1);
    expect(botRef.current.api.setMessageReaction).toHaveBeenCalledWith(
      '100200300',
      987,
      [{ type: 'emoji', emoji: '⏳' }],
      { is_big: false },
    );
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
      headline: 'Searching the web',
      status: 'running',
      elapsed: '2m 14s',
      stop: { label: 'Stop', actionToken: 'stop-token-1' },
      items: [{ id: '1', title: 'First', status: 'pending' }],
    });
    await channel.renderAgentTodo('tg:-100123', {
      threadId: '77',
      items: [{ id: '2', title: 'Second', status: 'pending' }],
    });
    await channel.renderAgentTodo('tg:-100123', {
      threadId: '42',
      status: 'done',
      stop: { label: 'Stop', actionToken: 'stale-stop-token' },
      items: [{ id: '1', title: 'First', status: 'completed' }],
    });

    expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
      1,
      '-100123',
      expect.stringContaining('⏳ Searching the web · 2m 14s'),
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
    expect(currentBot().api.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty(
      'reply_markup',
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
      expect.objectContaining({ reply_markup: { inline_keyboard: [] } }),
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
      expect(currentBot().filterHandlers.has('my_chat_member')).toBe(true);
      expect(currentBot().filterHandlers.has('chat_member')).toBe(false);
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

  describe('group join onboarding', () => {
    it('prompts a registered control DM when an approver adds the bot', async () => {
      const { opts, coordinator } = createGroupJoinOnboardingOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMyChatMember(createMyChatMemberCtx({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:-1001234',
        expect.any(String),
        'Ops Room',
        'telegram',
        true,
        { providerAccountId: 'telegram_default' },
      );
      expect(coordinator.recordPrompt).toHaveBeenCalledWith({
        providerAccountId: 'telegram_default',
        chatJid: 'tg:-1001234',
        adder: '111',
        approver: '222',
        promptConversationJid: 'tg:222',
        promptAgentFolder: 'whatsapp_main',
      });
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '222',
        "@bob added Andy to 'Ops Room' (-1001234). Respond there?",
        expect.objectContaining({
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Yes', callback_data: 'gjoin:yes:join-1' },
                { text: 'No', callback_data: 'gjoin:no:join-1' },
              ],
            ],
          },
        }),
      );
    });

    it('prompts when the bot is added with restrictions (restricted, is_member)', async () => {
      const { opts, coordinator } = createGroupJoinOnboardingOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMyChatMember(
        createMyChatMemberCtx({
          newMember: { status: 'restricted', is_member: true },
        }),
      );

      expect(coordinator.recordPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ chatJid: 'tg:-1001234', adder: '111' }),
      );
    });

    it('answers the callback with the true outcome when the receipt edit fails', async () => {
      const { opts, coordinator } = createGroupJoinOnboardingOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await triggerMyChatMember(createMyChatMemberCtx({}));
      currentBot().api.editMessageText.mockRejectedValueOnce(
        new Error('edit failed'),
      );
      const answerCallbackQuery = vi.fn();

      await triggerCallbackQuery({
        callbackQuery: {
          data: latestGroupJoinCallback('yes'),
          from: { id: 222 },
          message: { chat: { id: 222 }, message_id: 987 },
        },
        chat: { id: 222 },
        from: { id: 222 },
        api: currentBot().api,
        me: { username: 'andy_ai_bot' },
        answerCallbackQuery,
      });

      // Registration is persisted before the receipt edit; a transient edit
      // failure must not fail the callback or misreport the outcome.
      expect(coordinator.register).toHaveBeenCalled();
      expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Registered.' });
    });

    it('does not prompt and info-logs when a stranger adds the bot', async () => {
      const { opts, coordinator } = createGroupJoinOnboardingOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMyChatMember(createMyChatMemberCtx({ fromId: 999 }));

      expect(coordinator.recordPrompt).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'telegram',
          chatId: '-1001234',
          adder: '999',
        }),
        'Telegram group join ignored: adder is not a registered control approver',
      );
    });

    it('info-logs when no registered control DM can receive the prompt', async () => {
      const { opts, coordinator } = createGroupJoinOnboardingOpts();
      const settings = opts.runtimeSettings!();
      delete settings.conversations.operator_dm;
      opts.runtimeSettings = vi.fn(() => settings);
      opts.conversationRoutes = vi.fn(() => ({
        'tg:100200300': {
          name: 'Known Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2026-07-18T00:00:00.000Z',
          providerAccountId: 'telegram_default',
        },
      }));
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMyChatMember(createMyChatMemberCtx({}));

      expect(coordinator.recordPrompt).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: '-1001234', adder: '111' }),
        'Telegram group join has no registered control DM for onboarding',
      );
    });

    it('registers a group join on Yes and edits the prompt into a receipt', async () => {
      const { opts, coordinator } = createGroupJoinOnboardingOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await triggerMyChatMember(createMyChatMemberCtx({}));
      const answerCallbackQuery = vi.fn();

      await triggerCallbackQuery({
        callbackQuery: {
          data: latestGroupJoinCallback('yes'),
          from: { id: 222 },
          message: { chat: { id: 222 }, message_id: 987 },
        },
        chat: { id: 222 },
        from: { id: 222 },
        api: currentBot().api,
        me: { username: 'andy_ai_bot' },
        answerCallbackQuery,
      });

      expect(coordinator.register).toHaveBeenCalledWith({
        id: 'join-1',
        externalId: '-1001234',
        title: 'Ops Room',
        approvedBy: '222',
      });
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        222,
        987,
        'Registered. Members can reach the agent with @andy_ai_bot. Anyone in the group can @mention; actions still need your approval.',
        { reply_markup: { inline_keyboard: [] } },
      );
      expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Registered.' });
    });

    it('dismisses on No, keeps stranger re-add silent, and re-prompts on approver re-add', async () => {
      const { opts, coordinator, getRecord } = createGroupJoinOnboardingOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await triggerMyChatMember(createMyChatMemberCtx({}));

      await triggerCallbackQuery({
        callbackQuery: {
          data: latestGroupJoinCallback('no'),
          from: { id: 222 },
          message: { chat: { id: 222 }, message_id: 987 },
        },
        chat: { id: 222 },
        from: { id: 222 },
        api: currentBot().api,
        answerCallbackQuery: vi.fn(),
      });

      expect(getRecord()?.status).toBe('dismissed');
      await triggerMyChatMember(createMyChatMemberCtx({ fromId: 999 }));
      expect(coordinator.recordPrompt).toHaveBeenCalledTimes(1);
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);

      await triggerMyChatMember(createMyChatMemberCtx({}));

      expect(coordinator.recordPrompt).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(getRecord()).toMatchObject({ id: 'join-2', status: 'prompted' });
    });

    it('re-prompts after an unanswered prompt is lost across a remove and re-add', async () => {
      const { opts, coordinator, getRecord } = createGroupJoinOnboardingOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMyChatMember(createMyChatMemberCtx({}));
      await triggerMyChatMember(
        createMyChatMemberCtx({ oldStatus: 'member', newStatus: 'left' }),
      );
      await triggerMyChatMember(createMyChatMemberCtx({}));

      expect(coordinator.recordPrompt).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(getRecord()).toMatchObject({ id: 'join-2', status: 'prompted' });
    });

    it('does nothing when the joined group is already registered', async () => {
      const { opts, coordinator } = createGroupJoinOnboardingOpts();
      const baseRoutes = opts.conversationRoutes();
      opts.conversationRoutes = vi.fn(() => ({
        ...baseRoutes,
        'tg:-1001234': {
          name: 'Ops Room',
          folder: 'whatsapp_main',
          trigger: '@Andy',
          added_at: '2026-07-18T00:00:00.000Z',
          providerAccountId: 'telegram_default',
        },
      }));
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMyChatMember(createMyChatMemberCtx({}));

      expect(coordinator.recordPrompt).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
    });

    it('marks the durable row when the bot is kicked from a group', async () => {
      const { opts, coordinator } = createGroupJoinOnboardingOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMyChatMember(
        createMyChatMemberCtx({ oldStatus: 'member', newStatus: 'kicked' }),
      );

      expect(coordinator.markLeft).toHaveBeenCalledWith({
        providerAccountId: 'telegram_default',
        chatJid: 'tg:-1001234',
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'telegram',
          chatId: '-1001234',
        }),
        'Telegram bot left a group',
      );
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
        { providerAccountId: 'telegram_default' },
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

    it('delivers message for an agent-qualified group route', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage')]: {
            name: 'Test Group',
            folder: 'test-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerTextMessage(createTextCtx({ text: 'Hello agent route' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Hello agent route',
        }),
      );
    });

    it('does not treat a Telegram topic route as a whole group route', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage', '77')]: {
            name: 'Test Topic',
            folder: 'test-topic',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerTextMessage(createTextCtx({ text: 'Hello group' }));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers Telegram topic messages for exact agent-qualified topic routes', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage', '77')]: {
            name: 'Test Topic',
            folder: 'test-topic',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerTextMessage(
        createTextCtx({ text: 'Hello topic', messageThreadId: 77 }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Hello topic',
          thread_id: '77',
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
        { providerAccountId: 'telegram_default' },
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rate-limits unregistered Telegram group drop logs per chat', async () => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const ctx = createTextCtx({ chatId: -100987654321, text: 'Unknown' });

      await triggerTextMessage(ctx);
      await triggerTextMessage(ctx);

      const dropLogs = () =>
        vi
          .mocked(logger.info)
          .mock.calls.filter(
            ([, message]) =>
              message === 'Message from unregistered Telegram chat',
          );
      expect(dropLogs()).toHaveLength(1);
      expect(dropLogs()[0]?.[0]).toEqual(
        expect.objectContaining({
          provider: 'telegram',
          chatId: '-100987654321',
        }),
      );

      now += 60_000;
      await triggerTextMessage(ctx);

      expect(dropLogs()).toHaveLength(2);
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
        { providerAccountId: 'telegram_default' },
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
        { providerAccountId: 'telegram_default' },
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
        { providerAccountId: 'telegram_default' },
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

    it('downloads media for an agent-qualified group route', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage')]: {
            name: 'Test Group',
            folder: 'test-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMediaMessage(
        'message:photo',
        createMediaCtx({
          extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
        }),
      );
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo] (attachments/photo_1.jpg)',
        }),
      );
    });

    it('ignores Telegram media routes from another provider account', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage')]: {
            name: 'Other Account Group',
            folder: 'other-account',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_other',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMediaMessage(
        'message:photo',
        createMediaCtx({
          extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
        }),
      );
      await flushPromises();

      expect(currentBot().api.getFile).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not download media when multiple matching group route folders exist', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage')]: {
            name: 'Triage',
            folder: 'test-triage',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
          [makeAgentThreadQueueKey('tg:100200300', 'agent:ops')]: {
            name: 'Ops',
            folder: 'test-ops',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMediaMessage(
        'message:photo',
        createMediaCtx({
          extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
        }),
      );
      await flushPromises();

      expect(currentBot().api.getFile).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo]',
          attachments: [
            expect.objectContaining({
              externalId: 'photo_id',
              kind: 'image',
            }),
          ],
        }),
      );
      const delivered = vi.mocked(opts.onMessage).mock.calls[0]![1];
      expect(delivered.attachments[0]).not.toHaveProperty('storageRef');
    });

    it('downloads media for the selected multi-agent route', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage')]: {
            name: 'Triage',
            folder: 'test-triage',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
          [makeAgentThreadQueueKey('tg:100200300', 'agent:ops')]: {
            name: 'Ops',
            folder: 'test-ops',
            trigger: '@Ops',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMediaMessage(
        'message:photo',
        createMediaCtx({
          caption: '@Andy see file',
          extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
        }),
      );
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('photo_id');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        '/tmp/test-groups/test-triage/attachments/photo_1.jpg',
        expect.any(Buffer),
        { mode: 0o600 },
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo] (attachments/photo_1.jpg) @Andy see file',
          attachments: [
            expect.objectContaining({
              externalId: 'photo_id',
              kind: 'image',
              storageRef: 'attachments/photo_1.jpg',
            }),
          ],
        }),
      );
    });

    it('does not download media when multiple matching topic route folders exist', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage', '77')]: {
            name: 'Triage',
            folder: 'test-triage',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
          [makeAgentThreadQueueKey('tg:100200300', 'agent:ops', '77')]: {
            name: 'Ops',
            folder: 'test-ops',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMediaMessage(
        'message:photo',
        createMediaCtx({
          extra: {
            message_thread_id: 77,
            photo: [{ file_id: 'photo_id', width: 800 }],
          },
        }),
      );
      await flushPromises();

      expect(currentBot().api.getFile).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo]',
          thread_id: '77',
          attachments: [
            expect.objectContaining({
              externalId: 'photo_id',
              kind: 'image',
            }),
          ],
        }),
      );
      const delivered = vi.mocked(opts.onMessage).mock.calls[0]![1];
      expect(delivered.attachments[0]).not.toHaveProperty('storageRef');
    });

    it('does not download media through a Telegram topic route for whole-group media', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage', '77')]: {
            name: 'Test Topic',
            folder: 'test-topic',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMediaMessage(
        'message:photo',
        createMediaCtx({
          extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
        }),
      );
      await flushPromises();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(currentBot().api.getFile).not.toHaveBeenCalled();
    });

    it('downloads media for exact Telegram topic agent routes', async () => {
      const opts = createTestOpts({
        conversationRoutes: vi.fn(() => ({
          [makeAgentThreadQueueKey('tg:100200300', 'agent:triage', '77')]: {
            name: 'Test Topic',
            folder: 'test-topic',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            providerAccountId: 'telegram_default',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMediaMessage(
        'message:photo',
        createMediaCtx({
          extra: {
            message_thread_id: 77,
            photo: [{ file_id: 'photo_id', width: 800 }],
          },
        }),
      );
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('photo_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo] (attachments/photo_1.jpg)',
          thread_id: '77',
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
          providerAccountId: 'telegram_default',
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

    it('uploads message files as Telegram documents', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Report attached', {
        files: [
          {
            filename: 'report.txt',
            contentType: 'text/plain',
            sizeBytes: 6,
            content: new TextEncoder().encode('report'),
          },
        ],
      });

      expect(currentBot().api.sendDocument).toHaveBeenCalledWith(
        '100200300',
        expect.objectContaining({ filename: 'report.txt' }),
        expect.objectContaining({ caption: 'report.txt' }),
      );
    });

    it('keeps Telegram text delivery when document upload fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      currentBot().api.sendDocument.mockRejectedValueOnce(
        new Error('upload failed'),
      );

      await expect(
        channel.sendMessage('tg:100200300', 'Report attached', {
          files: [
            {
              filename: 'report.txt',
              contentType: 'text/plain',
              sizeBytes: 6,
              content: new TextEncoder().encode('report'),
            },
          ],
        }),
      ).resolves.toMatchObject({ externalMessageId: '987' });
      expect(currentBot().api.sendMessage).toHaveBeenLastCalledWith(
        '100200300',
        'Attachment unavailable in Telegram: report.txt upload failed.',
        {},
      );
    });

    it('announces Telegram documents that exceed the upload cap', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Report attached', {
        files: [
          {
            filename: 'large.txt',
            contentType: 'text/plain',
            sizeBytes: 51 * 1024 * 1024,
            content: new Uint8Array(),
          },
        ],
      });

      expect(currentBot().api.sendDocument).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).toHaveBeenLastCalledWith(
        '100200300',
        'Attachment unavailable in Telegram: large.txt exceeds 50 MB.',
        {},
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
                { text: 'Retry now', callback_data: 'r:job-1' },
                { text: 'Pause job', callback_data: 'dl:pause' },
              ],
            ],
          },
        }),
      );
    });

    it('keeps Telegram retry buttons for long generated job ids', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const jobId = `job-${'a'.repeat(40)}-${'b'.repeat(12)}`;

      await channel.sendMessage('tg:100200300', 'Paused after failures', {
        actionAffordances: [
          { kind: 'scheduler_run_now', label: 'Retry now', jobId },
        ],
      });

      const callbackData =
        currentBot().api.sendMessage.mock.calls[0]?.[2]?.reply_markup
          ?.inline_keyboard?.[0]?.[0]?.callback_data;
      expect(callbackData).toBe(`r:${jobId}`);
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);
    });

    it('routes Telegram scheduler run-now action buttons through the message action callback', async () => {
      const opts = createTestOpts({ onMessageAction: vi.fn() } as any);
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const callbackCtx = {
        callbackQuery: {
          data: 'r:job-1',
          message: {
            chat: { id: 100200300 },
            message_thread_id: 42,
          },
        },
        chat: { id: 100200300 },
        from: { id: 111 },
        answerCallbackQuery: vi.fn(),
      };

      await triggerCallbackQuery(callbackCtx);

      expect(opts.onMessageAction).toHaveBeenCalledWith({
        kind: 'scheduler_run_now',
        conversationJid: 'tg:100200300',
        providerAccountId: 'telegram_default',
        threadId: '42',
        userId: '111',
        jobId: 'job-1',
      });
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Checking retry request.',
      });
    });

    it('omits Telegram live stop action buttons but still routes stale callbacks', async () => {
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
        expect.not.objectContaining({ reply_markup: expect.anything() }),
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
        providerAccountId: 'telegram_default',
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
        .mockResolvedValueOnce({ message_id: 203 })
        .mockResolvedValueOnce({ message_id: 204 });

      const result = await channel.sendMessage(
        'tg:100200300',
        chunkedWithLiteralMarkers,
      );

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(5);
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
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        5,
        '100200300',
        expect.any(String),
        {},
      );
      expect(result).toEqual(
        expect.objectContaining({
          deliveredParts: 4,
          totalParts: 4,
          externalMessageIds: ['201', '202', '203', '204'],
          warnings: ['telegram.message.chunked:4:3500'],
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

    it('retries Telegram group edits after retry_after rate limits', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot()
        .api.editMessageText.mockRejectedValueOnce({
          error_code: 429,
          parameters: { retry_after: 0.001 },
          message: 'Too Many Requests',
        })
        .mockResolvedValueOnce(undefined);

      try {
        await channel.sendStreamingChunk('tg:-1001234567890', 'group update');
        await vi.advanceTimersByTimeAsync(950);
        const updatePromise = channel.sendStreamingChunk(
          'tg:-1001234567890',
          ' more',
        );
        await Promise.resolve();

        expect(currentBot().api.editMessageText).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await updatePromise;

        expect(currentBot().api.editMessageText).toHaveBeenCalledTimes(2);
        expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
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

    it('stops Telegram overflow parts when the stream guard changes mid-send', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const jid = 'tg:-1001234567890';
      const threadId = '42';
      await channel.sendStreamingChunk(jid, 'x'.repeat(8000), {
        generation: 1,
        threadId,
      });
      currentBot().api.sendMessage.mockClear();
      let resolveFirstOverflow!: (value: { message_id: number }) => void;
      currentBot().api.sendMessage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstOverflow = resolve;
          }),
      );

      const completion = channel.sendStreamingChunk(jid, '', {
        done: true,
        generation: 1,
        threadId,
      });
      await vi.waitFor(() =>
        expect(currentBot().api.sendMessage).toHaveBeenCalledOnce(),
      );
      channel.resetStreaming(jid, { threadId });
      resolveFirstOverflow({ message_id: 988 });
      await completion;

      expect(currentBot().api.sendMessage).toHaveBeenCalledOnce();
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

    it('keeps targeted-reset group state when an old final edit completes', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const jid = 'tg:-1001234567890';
      const stream = { generation: 1, threadId: '42' };

      await channel.sendStreamingChunk(jid, 'old', stream);
      let finishOldEdit!: () => void;
      currentBot().api.editMessageText.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishOldEdit = resolve;
          }),
      );
      const oldCompletion = channel.sendStreamingChunk(jid, '', {
        ...stream,
        done: true,
      });
      await vi.waitFor(() =>
        expect(currentBot().api.editMessageText).toHaveBeenCalledTimes(1),
      );

      channel.resetStreaming(jid, { threadId: stream.threadId });
      await expect(
        channel.sendStreamingChunk(jid, 'new', stream),
      ).resolves.toBe(true);
      finishOldEdit();
      await oldCompletion;

      await expect(
        channel.sendStreamingChunk(jid, ' tail', {
          ...stream,
          done: true,
        }),
      ).resolves.toBe(true);
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.editMessageText).toHaveBeenCalledTimes(2);
      expect(currentBot().api.editMessageText).toHaveBeenLastCalledWith(
        '-1001234567890',
        987,
        'new tail',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });

    it('keeps targeted-reset private draft state when an old final send completes', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const jid = 'tg:100200300';
      const stream = { generation: 1, threadId: '42' };

      await channel.sendStreamingChunk(jid, 'old', stream);
      await vi.waitFor(() =>
        expect(currentBot().api.sendMessageDraft).toHaveBeenCalledTimes(1),
      );
      let finishOldSend!: () => void;
      currentBot().api.sendMessage.mockImplementationOnce(
        () =>
          new Promise<{ message_id: number }>((resolve) => {
            finishOldSend = () => resolve({ message_id: 987 });
          }),
      );
      const oldCompletion = channel.sendStreamingChunk(jid, '', {
        ...stream,
        done: true,
      });
      await vi.waitFor(() =>
        expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1),
      );

      channel.resetStreaming(jid, { threadId: stream.threadId });
      await expect(
        channel.sendStreamingChunk(jid, 'new', stream),
      ).resolves.toBe(true);
      finishOldSend();
      await oldCompletion;

      await expect(
        channel.sendStreamingChunk(jid, ' tail', {
          ...stream,
          done: true,
        }),
      ).resolves.toBe(true);
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenLastCalledWith(
        '100200300',
        'new tail',
        expect.objectContaining({
          message_thread_id: 42,
          parse_mode: 'MarkdownV2',
        }),
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
        }),
      );
      expect(
        currentBot().api.sendMessage.mock.calls[0]?.[2],
      ).not.toHaveProperty('reply_markup');
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '-1001234567890',
        987,
        'Still working (1m 00s)...',
        expect.objectContaining({
          parse_mode: 'MarkdownV2',
        }),
      );
      expect(
        currentBot().api.editMessageText.mock.calls[0]?.[3],
      ).not.toHaveProperty('reply_markup');
    });

    it('drops action-only progress when Telegram has no renderable actions', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:-1001234567890', '', {
        actionOnly: true,
        actionAffordances: [
          {
            kind: 'live_turn_stop' as const,
            label: 'Stop',
            actionToken: 'token-1',
          },
        ],
      });

      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
    });

    it('suppresses terminal Done progress without posting a Done message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Working on it...');
      await channel.sendProgressUpdate('tg:100200300', 'Done.', {
        done: true,
      });

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Working on it...',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        987,
        'Working on it...',
        expect.objectContaining({
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [] },
        }),
      );
      expect(
        currentBot().api.editMessageText.mock.calls.some(
          (call) => call[2] === 'Done.',
        ),
      ).toBe(false);
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

    it('lets fresh progress replace a restored higher generation after restart', async () => {
      const runtimeHome = fs.mkdtempSync('/tmp/gantry-tg-progress-');
      const savedHome = process.env.GANTRY_HOME;
      process.env.GANTRY_HOME = runtimeHome;
      try {
        const first = new TelegramChannel('test-token', createTestOpts());
        await first.connect();
        await first.sendProgressUpdate('tg:100200300', 'Old waiting...', {
          generation: 4,
        });

        const second = new TelegramChannel('test-token', createTestOpts());
        await second.connect();
        currentBot().api.sendMessage.mockClear();
        currentBot().api.editMessageText.mockClear();

        await second.sendProgressUpdate('tg:100200300', 'Working again...', {
          generation: 2,
        });

        expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
        expect(currentBot().api.editMessageText).not.toHaveBeenCalled();

        await second.sendProgressUpdate('tg:100200300', 'Done again.', {
          done: true,
          generation: 3,
        });

        expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
          '100200300',
          987,
          'Done again.',
          expect.objectContaining({ parse_mode: 'MarkdownV2' }),
        );
      } finally {
        if (savedHome === undefined) delete process.env.GANTRY_HOME;
        else process.env.GANTRY_HOME = savedHome;
        fs.rmSync(runtimeHome, { recursive: true, force: true });
      }
    });

    it('clears restored Telegram progress buttons on connect', async () => {
      const runtimeHome = fs.mkdtempSync('/tmp/gantry-tg-progress-');
      const savedHome = process.env.GANTRY_HOME;
      process.env.GANTRY_HOME = runtimeHome;
      try {
        const first = new TelegramChannel('test-token', createTestOpts());
        await first.connect();
        await first.sendProgressUpdate('tg:100200300', 'Still working...', {
          generation: 4,
          actionAffordances: [
            { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
          ],
        });

        const second = new TelegramChannel('test-token', createTestOpts());
        await second.connect();

        expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
          '100200300',
          987,
          'Still working...',
          expect.objectContaining({
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [] },
          }),
        );
      } finally {
        if (savedHome === undefined) delete process.env.GANTRY_HOME;
        else process.env.GANTRY_HOME = savedHome;
        fs.rmSync(runtimeHome, { recursive: true, force: true });
      }
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

    it('lets newer replace-only progress take over the existing generation', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendProgressUpdate('tg:100200300', 'Waiting...', {
        generation: 4,
      });
      currentBot().api.sendMessage.mockClear();
      currentBot().api.editMessageText.mockClear();

      await channel.sendProgressUpdate('tg:100200300', 'Waiting...', {
        replaceOnly: true,
        generation: 7,
      });
      await channel.sendProgressUpdate('tg:100200300', 'Stale waiting...', {
        replaceOnly: true,
        generation: 6,
      });

      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();

      await channel.sendProgressUpdate('tg:100200300', 'Continuing...', {
        replaceOnly: true,
        generation: 8,
      });

      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        987,
        'Continuing...',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });

    it('restores progress handles after restart for newer replace-only generations', async () => {
      const runtimeHome = fs.mkdtempSync('/tmp/gantry-tg-progress-');
      const savedHome = process.env.GANTRY_HOME;
      process.env.GANTRY_HOME = runtimeHome;
      try {
        const first = new TelegramChannel('test-token', createTestOpts());
        await first.connect();
        await first.sendProgressUpdate('tg:100200300', 'Waiting...', {
          generation: 4,
        });

        const second = new TelegramChannel('test-token', createTestOpts());
        await second.connect();
        currentBot().api.sendMessage.mockClear();
        currentBot().api.editMessageText.mockClear();
        await second.sendProgressUpdate('tg:100200300', 'Waiting...', {
          replaceOnly: true,
          generation: 7,
        });
        await second.sendProgressUpdate('tg:100200300', 'Stale waiting...', {
          replaceOnly: true,
          generation: 6,
        });

        expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
        expect(currentBot().api.editMessageText).not.toHaveBeenCalled();

        await second.sendProgressUpdate('tg:100200300', 'Continuing...', {
          replaceOnly: true,
          generation: 8,
        });

        expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
          '100200300',
          987,
          'Continuing...',
          expect.objectContaining({ parse_mode: 'MarkdownV2' }),
        );
      } finally {
        if (savedHome === undefined) delete process.env.GANTRY_HOME;
        else process.env.GANTRY_HOME = savedHome;
        fs.rmSync(runtimeHome, { recursive: true, force: true });
      }
    });

    it('drops persisted Telegram progress handles for a different thread', async () => {
      const runtimeHome = fs.mkdtempSync('/tmp/gantry-tg-progress-');
      const savedHome = process.env.GANTRY_HOME;
      process.env.GANTRY_HOME = runtimeHome;
      try {
        const first = new TelegramChannel('test-token', createTestOpts());
        await first.connect();
        await first.sendProgressUpdate('tg:100200300', 'Waiting...', {
          threadId: '42',
          generation: 4,
        });

        const runDir = `${runtimeHome}/run`;
        const stateFile = fs
          .readdirSync(runDir)
          .find((name) => name.startsWith('telegram-progress-state-'));
        expect(stateFile).toBeTruthy();
        const statePath = `${runDir}/${stateFile}`;
        const entries = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any[];
        entries[0][1].threadId = 99;
        fs.writeFileSync(statePath, JSON.stringify(entries));

        const second = new TelegramChannel('test-token', createTestOpts());
        await second.connect();
        currentBot().api.sendMessage.mockClear();
        currentBot().api.editMessageText.mockClear();

        await second.sendProgressUpdate('tg:100200300', 'Continuing...', {
          threadId: '42',
          replaceOnly: true,
          generation: 5,
        });

        expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
        expect(currentBot().api.editMessageText).not.toHaveBeenCalled();

        await second.sendProgressUpdate('tg:100200300', 'Working again...', {
          threadId: '42',
          generation: 6,
        });

        expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
        expect(currentBot().api.editMessageText).not.toHaveBeenCalled();
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
    it('keeps colliding request ids scoped to the authorized agent', async () => {
      const channel = new TelegramChannel(
        'test-token',
        createTestOpts({
          isControlApproverAllowed: vi.fn(async () => true),
        }),
      );
      await channel.connect();
      const first = channel.requestPermissionApproval('tg:100200300', {
        requestId: 'shared-request',
        sourceAgentFolder: 'agent-a',
        targetJid: 'tg:100200300',
        toolName: 'Bash',
      });
      await flushPromises();
      const firstCallback = latestPermissionCallback('Allow once');
      const second = channel.requestPermissionApproval('tg:100200300', {
        requestId: 'shared-request',
        sourceAgentFolder: 'agent-b',
        targetJid: 'tg:100200300',
        toolName: 'Bash',
      });
      await flushPromises();
      const secondCallback = latestPermissionCallback('Cancel');
      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });

      await triggerCallbackQuery({
        callbackQuery: { data: firstCallback },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });

      await expect(first).resolves.toMatchObject({ approved: true });
      expect(secondSettled).toBe(false);
      await triggerCallbackQuery({
        callbackQuery: { data: secondCallback },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await expect(second).resolves.toMatchObject({
        approved: false,
        mode: 'cancel',
      });
    });

    it('releases a failed Telegram terminalization claim for retry', async () => {
      const requestId = 'permission-retry';
      const interactions = [
        {
          id: `pending-${requestId}`,
          appId: 'default',
          runId: 'run-1',
          kind: 'permission' as const,
          status: 'pending' as const,
          payload: {
            sourceAgentFolder: 'whatsapp_main',
            requestId,
            request: {
              requestId,
              sourceAgentFolder: 'whatsapp_main',
              targetJid: 'tg:100200300',
              toolName: 'Bash',
            },
          } as Record<string, unknown>,
          idempotencyKey: `default:permission:whatsapp_main:${requestId}`,
        },
      ];
      const claims = permissionClaimRepository(interactions);
      configurePendingInteractionDurability({
        repository: {
          ...claims,
          listPendingInteractions: vi.fn(async () => interactions),
          updatePendingInteractionPayload: vi.fn((input) =>
            updatePendingInteractionPayload(interactions, input),
          ),
        } as never,
      });
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const decision = channel.requestPermissionApproval('tg:100200300', {
        requestId,
        sourceAgentFolder: 'whatsapp_main',
        targetJid: 'tg:100200300',
        toolName: 'Bash',
      });
      await flushPromises();
      const callback = latestPermissionCallback('Allow once');
      currentBot().api.deleteMessage.mockRejectedValueOnce(
        new Error('delete failed'),
      );
      currentBot().api.editMessageText.mockRejectedValueOnce(
        new Error('edit failed'),
      );
      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('fallback failed'),
      );

      await triggerCallbackQuery({
        callbackQuery: { data: callback },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      expect(claims.releasePendingPermissionCallback).toHaveBeenCalledOnce();

      await triggerCallbackQuery({
        callbackQuery: { data: callback },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await expect(decision).resolves.toMatchObject({ approved: true });
      expect(claims.claimPendingPermissionCallback).toHaveBeenCalledTimes(2);
    });

    it('clears a live batch prompt when its post-send binding is already resolved', async () => {
      const requests = ['perm-bind-1', 'perm-bind-2'].map((requestId) => ({
        id: `pending-${requestId}`,
        appId: 'default',
        runId: 'run-1',
        kind: 'permission' as const,
        status: 'pending' as const,
        payload: {
          sourceAgentFolder: 'whatsapp_main',
          requestId,
          request: {
            requestId,
            sourceAgentFolder: 'whatsapp_main',
            targetJid: 'tg:100200300',
            runId: 'run-1',
            toolName: 'Bash',
          },
        },
        callbackRoute: null,
        idempotencyKey: `default:permission:whatsapp_main:${requestId}`,
        approverRef: null,
        resolution: null,
        createdAt: '2026-07-16T00:00:00.000Z',
        expiresAt: '2026-07-17T00:00:00.000Z',
        resolvedAt: null,
      }));
      const listPendingInteractions = vi
        .fn()
        .mockResolvedValueOnce(requests)
        .mockResolvedValueOnce([]);
      configurePendingInteractionDurability({
        repository: {
          listPendingInteractions,
          updatePendingInteractionPayload: vi.fn((input) =>
            updatePendingInteractionPayload(requests, input),
          ),
        } as never,
      });
      telegramPromptBindingBehavior.strict = true;
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const onPromptDelivered = vi.fn();
      const batch = createPermissionBatchRequest(
        requests.map((entry) => ({
          requestId: String(entry.payload.requestId),
          sourceAgentFolder: 'whatsapp_main',
          targetJid: 'tg:100200300',
          runId: 'run-1',
          toolName: 'Bash',
        })),
        ['1. Command', '2. File action'],
      );

      await expect(
        channel.requestPermissionApproval(
          'tg:100200300',
          batch,
          onPromptDelivered,
        ),
      ).resolves.toMatchObject({ approved: false });

      expect(currentBot().api.sendMessage).toHaveBeenCalledOnce();
      expect(listPendingInteractions).toHaveBeenCalledTimes(2);
      expect(onPromptDelivered).not.toHaveBeenCalled();
      expect((channel as any).pendingPermissionPrompts.size).toBe(0);
    });

    it('propagates Telegram post-send permission persistence failure and retains the waiter', async () => {
      telegramPromptBindingBehavior.strict = true;
      const interactions = telegramPromptBindingBehavior.interactions;
      let updates = 0;
      configurePendingInteractionDurability({
        repository: {
          ...permissionClaimRepository(interactions),
          listPendingInteractions: vi.fn(async () => interactions),
          updatePendingInteractionPayload: vi.fn(async (input) => {
            updates += 1;
            if (updates === 2) throw new Error('write failed');
            return await updatePendingInteractionPayload(interactions, input);
          }),
        } as never,
      });
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      await expect(
        channel.requestPermissionApproval('tg:100200300', {
          requestId: 'perm-post-send-persist-failure',
          sourceAgentFolder: 'whatsapp_main',
          targetJid: 'tg:100200300',
          toolName: 'Bash',
        }),
      ).rejects.toMatchObject({ name: 'DurableInteractionPersistenceError' });
      expect((channel as any).pendingPermissionPrompts.size).toBe(1);
      for (const pending of (
        channel as any
      ).pendingPermissionPrompts.values()) {
        clearTimeout(pending.timer);
      }
      (channel as any).pendingPermissionPrompts.clear();
    });

    it('fails closed for stale timed-grant callbacks', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-stale',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Bash',
        },
      );
      await flushPromises();
      const promptButtons = currentBot()
        .api.sendMessage.mock.calls.at(-1)?.[2]
        .reply_markup.inline_keyboard.flat();
      let settled = false;
      void decisionPromise.then(() => {
        settled = true;
      });
      const staleCtx = {
        callbackQuery: { data: 'perm:allow_timed_grant:perm-stale' },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };

      await triggerCallbackQuery(staleCtx);

      expect(staleCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Permission request is no longer active.',
        show_alert: true,
      });
      expect(settled).toBe(false);

      await triggerCallbackQuery({
        callbackQuery: {
          data: promptButtons.find(
            (button: { text: string }) => button.text === 'Cancel',
          )?.callback_data,
        },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await expect(decisionPromise).resolves.toMatchObject({
        approved: false,
        mode: 'cancel',
      });
    });

    it('acknowledges that Review each is starting individual review', async () => {
      const requests = ['permission-1', 'permission-2'].map((requestId) => ({
        id: `pending-${requestId}`,
        appId: 'default',
        runId: 'run-1',
        kind: 'permission' as const,
        status: 'pending' as const,
        payload: {
          sourceAgentFolder: 'whatsapp_main',
          requestId,
          request: {
            requestId,
            sourceAgentFolder: 'whatsapp_main',
            targetJid: 'tg:100200300',
            runId: 'run-1',
            toolName: 'Bash',
          },
        } as Record<string, unknown>,
        callbackRoute: null,
        idempotencyKey: `default:permission:whatsapp_main:${requestId}`,
        approverRef: null,
        resolution: null,
        createdAt: '2026-07-16T00:00:00.000Z',
        expiresAt: '2026-07-17T00:00:00.000Z',
        resolvedAt: null,
      }));
      configurePendingInteractionDurability({
        repository: {
          ...permissionClaimRepository(requests),
          listPendingInteractions: vi.fn(async () => requests),
          updatePendingInteractionPayload: vi.fn((input) =>
            updatePendingInteractionPayload(requests, input),
          ),
        } as never,
      });
      const batch = createPermissionBatchRequest(
        requests.map((entry) => ({
          requestId: entry.payload.requestId as string,
          sourceAgentFolder: 'whatsapp_main',
          targetJid: 'tg:100200300',
          runId: 'run-1',
          toolName: 'Bash',
        })),
        ['1. Command (git status)', '2. Command (git diff)'],
      );
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        batch,
      );
      await flushPromises();
      const buttons = currentBot()
        .api.sendMessage.mock.calls.at(-1)?.[2]
        .reply_markup.inline_keyboard.flat();
      const callbackData = buttons.find(
        (button: { text: string }) => button.text === 'Review each',
      )?.callback_data;
      const callbackCtx = {
        callbackQuery: { data: callbackData },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };

      await triggerCallbackQuery(callbackCtx);

      await expect(decisionPromise).resolves.toMatchObject({
        approved: true,
        batchDecision: 'review_each',
      });
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Starting individual review.',
      });
    });

    it('opens individual Telegram prompts after Review each instead of cancelling the batch', async () => {
      const requests = ['permission-1', 'permission-2'].map((requestId) => ({
        id: `pending-${requestId}`,
        appId: 'default',
        runId: 'run-1',
        kind: 'permission' as const,
        status: 'pending' as const,
        payload: {
          sourceAgentFolder: 'whatsapp_main',
          requestId,
          request: {
            requestId,
            sourceAgentFolder: 'whatsapp_main',
            targetJid: 'tg:100200300',
            runId: 'run-1',
            toolName: 'Bash',
            toolInput: { command: `echo ${requestId}` },
          },
        } as Record<string, unknown>,
        callbackRoute: null,
        idempotencyKey: `default:permission:whatsapp_main:${requestId}`,
        approverRef: null,
        resolution: null,
        createdAt: '2026-07-16T00:00:00.000Z',
        expiresAt: '2026-07-17T00:00:00.000Z',
        resolvedAt: null,
      }));
      configurePendingInteractionDurability({
        repository: {
          ...permissionClaimRepository(requests),
          listPendingInteractions: vi.fn(async () => requests),
          updatePendingInteractionPayload: vi.fn((input) =>
            updatePendingInteractionPayload(requests, input),
          ),
        } as never,
      });
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      vi.useFakeTimers();
      const requester = createPermissionApprovalRequester({
        findBoundChannel: () => channel,
        asPermissionApprovalSurface: (bound) => bound as TelegramChannel,
        interactionLifecycle: { logger: { error: vi.fn() } },
      });
      const decisions = requests.map((entry) =>
        requester({
          requestId: String(entry.payload.requestId),
          sourceAgentFolder: 'whatsapp_main',
          targetJid: 'tg:100200300',
          runId: 'run-1',
          toolName: 'Bash',
          toolInput: { command: `echo ${entry.payload.requestId}` },
        }),
      );

      await vi.advanceTimersByTimeAsync(1500);
      vi.useRealTimers();
      const batchButtons = currentBot()
        .api.sendMessage.mock.calls.at(-1)?.[2]
        .reply_markup.inline_keyboard.flat();
      await triggerCallbackQuery({
        callbackQuery: {
          data: batchButtons.find(
            (button: { text: string }) => button.text === 'Review each',
          )?.callback_data,
        },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await flushPromises();

      for (let index = 0; index < 2; index += 1) {
        const buttons = currentBot()
          .api.sendMessage.mock.calls.at(-1)?.[2]
          .reply_markup.inline_keyboard.flat();
        await triggerCallbackQuery({
          callbackQuery: {
            data: buttons.find(
              (button: { text: string }) => button.text === 'Cancel',
            )?.callback_data,
          },
          chat: { id: 100200300 },
          from: { id: 222, first_name: 'Admin' },
          answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        });
        await flushPromises();
      }

      await expect(Promise.all(decisions)).resolves.toEqual([
        expect.objectContaining({ approved: false, mode: 'cancel' }),
        expect.objectContaining({ approved: false, mode: 'cancel' }),
      ]);
      for (const request of requests) {
        expect(request.payload).not.toHaveProperty('permissionBatchCallbackId');
        expect(request.payload).not.toHaveProperty('permissionBatchRequestIds');
        expect(request.payload.permissionRecoveryEnvelope).toMatchObject({
          batch: null,
        });
      }
      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('lets exactly one concurrent Allow all or Review each Telegram callback claim a batch', async () => {
      const requests = ['permission-race-1', 'permission-race-2'].map(
        (requestId) => ({
          id: `pending-${requestId}`,
          appId: 'default',
          runId: 'run-race',
          kind: 'permission' as const,
          status: 'pending' as const,
          payload: {
            sourceAgentFolder: 'whatsapp_main',
            requestId,
            targetJid: 'tg:100200300',
            decisionPolicy: 'same_channel',
            request: {
              requestId,
              sourceAgentFolder: 'whatsapp_main',
              targetJid: 'tg:100200300',
              decisionPolicy: 'same_channel',
              toolName: 'Bash',
            },
          } as Record<string, unknown>,
          callbackRoute: null,
          idempotencyKey: `default:permission:whatsapp_main:${requestId}`,
          approverRef: null,
          resolution: null,
          createdAt: '2026-07-16T00:00:00.000Z',
          expiresAt: '2026-07-17T00:00:00.000Z',
          resolvedAt: null,
        }),
      );
      const claims = permissionClaimRepository(requests);
      configurePendingInteractionDurability({
        repository: {
          ...claims,
          listPendingInteractions: vi.fn(async () => requests),
          updatePendingInteractionPayload: vi.fn((input) =>
            updatePendingInteractionPayload(requests, input),
          ),
        } as never,
      });
      const batch = createPermissionBatchRequest(
        requests.map((entry) => ({
          requestId: String(entry.payload.requestId),
          sourceAgentFolder: 'whatsapp_main',
          targetJid: 'tg:100200300',
          runId: 'run-race',
          toolName: 'Bash',
        })),
        ['1. Command (git status)', '2. Command (git diff)'],
      );
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        batch,
      );
      await flushPromises();
      const buttons = currentBot()
        .api.sendMessage.mock.calls.at(-1)?.[2]
        .reply_markup.inline_keyboard.flat();
      const allowAll = buttons.find(
        (button: { text: string }) => button.text === 'Allow all',
      )?.callback_data;
      const reviewEach = buttons.find(
        (button: { text: string }) => button.text === 'Review each',
      )?.callback_data;
      const providerCallbackId = String(allowAll).split(':').at(-1);
      expect(requests[0]?.payload).toMatchObject({
        permissionCallbackId: providerCallbackId,
        permissionBatchCallbackId: batch.requestId,
      });
      const allowContext = {
        callbackQuery: { data: allowAll },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      const reviewContext = {
        callbackQuery: { data: reviewEach },
        chat: { id: 100200300 },
        from: { id: 333, first_name: 'Second Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };

      await Promise.all([
        triggerCallbackQuery(allowContext),
        triggerCallbackQuery(reviewContext),
      ]);

      await expect(decisionPromise).resolves.toMatchObject({ approved: true });
      const outcomes = [allowContext, reviewContext].map(
        (context) => context.answerCallbackQuery.mock.calls.at(-1)?.[0]?.text,
      );
      expect(
        outcomes.filter(
          (outcome) => outcome === 'Permission request was already decided.',
        ),
      ).toHaveLength(1);

      const replayContext = {
        callbackQuery: { data: allowAll },
        chat: { id: 100200300 },
        from: { id: 444, first_name: 'Third Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(replayContext);

      expect(claims.claimPendingPermissionCallback).toHaveBeenCalledTimes(2);
      expect(replayContext.answerCallbackQuery).toHaveBeenLastCalledWith({
        text: 'Permission request is no longer active.',
        show_alert: true,
      });
    });

    it('resolves every durable batch row from an opaque callback after restart', async () => {
      const requests = ['perm-batch-1', 'perm-batch-2'].map((requestId) => ({
        id: `pending-${requestId}`,
        appId: 'default',
        runId: null,
        kind: 'permission' as const,
        status: 'pending' as const,
        payload: {
          sourceAgentFolder: 'whatsapp_main',
          requestId,
          conversationId: 'tg:100200300',
          decisionPolicy: 'same_channel',
          toolName: 'Bash',
          request: {
            requestId,
            sourceAgentFolder: 'whatsapp_main',
            targetJid: 'tg:100200300',
            decisionPolicy: 'same_channel' as const,
            toolName: 'Bash',
          },
        } as Record<string, unknown>,
        callbackRoute: null,
        idempotencyKey: `default:permission:whatsapp_main:${requestId}`,
        approverRef: null,
        resolution: null,
        createdAt: '2026-07-16T00:00:00.000Z',
        expiresAt: '2026-07-17T00:00:00.000Z',
        resolvedAt: null,
      }));
      const repository = {
        ...permissionClaimRepository(requests),
        listPendingInteractions: vi.fn(async () => requests),
        updatePendingInteractionPayload: vi.fn((input) =>
          updatePendingInteractionPayload(requests, input),
        ),
        resolvePendingInteraction: vi.fn(async () => true),
      };
      configurePendingInteractionDurability({
        repository: repository as never,
      });
      const batch = createPermissionBatchRequest(
        requests.map((entry) => entry.payload.request as never),
        ['1. Read file', '2. Run command'],
      );
      const originalChannel = new TelegramChannel(
        'test-token',
        createTestOpts(),
      );
      await originalChannel.connect();
      void originalChannel.requestPermissionApproval('tg:100200300', batch);
      await flushPromises();
      const callbackData =
        currentBot().api.sendMessage.mock.calls.at(-1)?.[2].reply_markup
          .inline_keyboard[0][0].callback_data;

      const recoveredChannel = new TelegramChannel(
        'test-token',
        createTestOpts(),
      );
      await recoveredChannel.connect();
      const callbackCtx = {
        callbackQuery: {
          data: callbackData,
          message: { message_id: 987, chat: { id: 100200300 } },
        },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        api: currentBot().api,
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };

      await triggerCallbackQuery(callbackCtx);

      expect(repository.resolvePendingInteraction).toHaveBeenCalledTimes(2);
      expect(repository.resolvePendingInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: 'default:permission:whatsapp_main:perm-batch-1',
          status: 'resolved',
          resolution: expect.objectContaining({
            approved: true,
            mode: 'allow_once',
          }),
        }),
      );
      expect(repository.resolvePendingInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: 'default:permission:whatsapp_main:perm-batch-2',
          status: 'resolved',
          resolution: expect.objectContaining({
            approved: true,
            mode: 'allow_once',
          }),
        }),
      );
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Decision recorded. Details will update in chat.',
        show_alert: false,
      });
    });

    it('recovers Review each by dispatching every member prompt before settlement', async () => {
      const requests = ['perm-review-1', 'perm-review-2'].map((requestId) => ({
        id: `pending-${requestId}`,
        appId: 'default',
        runId: null,
        kind: 'permission' as const,
        status: 'pending' as const,
        payload: {
          sourceAgentFolder: 'whatsapp_main',
          requestId,
          targetJid: 'tg:100200300',
          decisionPolicy: 'same_channel',
          request: {
            requestId,
            sourceAgentFolder: 'whatsapp_main',
            targetJid: 'tg:100200300',
            decisionPolicy: 'same_channel' as const,
            toolName: 'Bash',
          },
        } as Record<string, unknown>,
        idempotencyKey: `default:permission:whatsapp_main:${requestId}`,
      }));
      const claims = permissionClaimRepository(requests);
      const repository = {
        ...claims,
        listPendingInteractions: vi.fn(async () => requests),
        updatePendingInteractionPayload: vi.fn((input) =>
          updatePendingInteractionPayload(requests, input),
        ),
        resolvePendingInteraction: vi.fn(async () => true),
      };
      configurePendingInteractionDurability({
        repository: repository as never,
      });
      const batch = createPermissionBatchRequest(
        requests.map((entry) => entry.payload.request as never),
        ['1. Command without a shared scope', '2. Different command shape'],
      );
      batch.decisionOptions = ['allow_persistent_rule', 'cancel'];
      const originalChannel = new TelegramChannel(
        'test-token',
        createTestOpts(),
      );
      await originalChannel.connect();
      void originalChannel.requestPermissionApproval('tg:100200300', batch);
      await flushPromises();
      const buttons = currentBot()
        .api.sendMessage.mock.calls.at(-1)?.[2]
        .reply_markup.inline_keyboard.flat();
      const callbackData = buttons.find(
        (button: { text: string }) => button.text === 'Review each',
      )?.callback_data;
      expect(
        buttons.some((button: { text: string }) => button.text === 'Allow all'),
      ).toBe(false);

      const recoveredChannel = new TelegramChannel(
        'test-token',
        createTestOpts(),
      );
      await recoveredChannel.connect();
      const dispatchRecoveredMember = vi.fn(async (request: any) => ({
        delivered: true as const,
        decision: {
          approved: false,
          mode: 'cancel' as const,
          decidedBy: '222',
          permissionCallbackClaim: {
            id: `member-claim-${request.requestId}`,
            scope: {
              appId: 'default',
              sourceAgentFolder: request.sourceAgentFolder,
              interactionId: request.requestId,
            },
          },
        },
      }));
      configurePermissionReviewEachDispatcher(dispatchRecoveredMember);
      const callbackCtx = {
        callbackQuery: {
          data: callbackData,
          message: { message_id: 987, chat: { id: 100200300 } },
        },
        chat: { id: 100200300 },
        from: { id: 222, first_name: 'Admin' },
        api: currentBot().api,
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };

      await triggerCallbackQuery(callbackCtx);

      expect(claims.claimPendingPermissionCallback).toHaveBeenCalledWith({
        claim: expect.objectContaining({
          intent: expect.objectContaining({ mode: 'allow_persistent_rule' }),
          match: expect.objectContaining({ kind: 'batch' }),
        }),
      });
      expect(claims.settlePendingPermissionCallback).toHaveBeenCalledOnce();
      expect(dispatchRecoveredMember).toHaveBeenCalledTimes(2);
      expect(repository.resolvePendingInteraction).toHaveBeenCalledTimes(2);
      expect(
        repository.resolvePendingInteraction.mock.calls.map(
          ([input]) => input.idempotencyKey,
        ),
      ).toEqual([
        'default:permission:whatsapp_main:perm-review-1',
        'default:permission:whatsapp_main:perm-review-2',
      ]);
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Decision recorded. Details will update in chat.',
        show_alert: false,
      });
    });

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
          '<b>View full command</b>\n<blockquote expandable>rm -rf /tmp/old-cache &amp;&amp; npm install</blockquote>',
        ),
        expect.objectContaining({ message_thread_id: 42, parse_mode: 'HTML' }),
      );
      expect(currentBot().api.sendMessage.mock.calls[0]?.[1]).toContain(
        'Runs: rm, npm',
      );
      expect(currentBot().api.sendMessage.mock.calls[0]?.[1]).not.toContain(
        'Command:',
      );

      const callbackCtx = {
        callbackQuery: { data: latestPermissionCallback('Allow once') },
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
        callbackQuery: { data: latestPermissionCallback('Allow once') },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      const decision = await decisionPromise;
      expect(decision.approved).toBe(true);
    });

    it('sends oversized permission full view files to the group next to the prompt', async () => {
      const opts = createTelegramGroupApprovalOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const tail = 'review-tail-after-shared-budget';
      const proposed = `${'x'.repeat(7000)}${tail}`;

      const decisionPromise = channel.requestPermissionApproval(
        'tg:-100200300',
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
      expect(currentBot().api.sendDocument).toHaveBeenCalledTimes(1);
      const documentCall = currentBot().api.sendDocument.mock.calls[0];
      expect(documentCall[0]).toBe('-100200300');
      expect(String((documentCall[2] as any)?.caption)).toContain(
        'Full details for:',
      );
      expect(String((documentCall[1] as any).data)).toContain(tail);
      const promptCall = calls.at(-1);
      expect(promptCall?.[0]).toBe('-100200300');
      expect(promptCall?.[1]).toContain('View diff: sent above for review.');
      expect(promptCall?.[2]).toMatchObject({
        parse_mode: 'HTML',
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array),
        }),
      });

      await triggerCallbackQuery({
        callbackQuery: { data: latestPermissionCallback('Allow once') },
        chat: { id: -100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      const decision = await decisionPromise;
      expect(decision.approved).toBe(true);
    });

    it('fails closed when oversized permission full view delivery fails', async () => {
      const opts = createTelegramGroupApprovalOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      currentBot().api.sendDocument.mockRejectedValue(
        new Error('upload failed'),
      );

      const decisionPromise = channel.requestPermissionApproval(
        'tg:-100200300',
        {
          requestId: 'perm-profile-undelivered',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'request_agent_profile_update',
          title: 'Update AGENTS.md',
          interaction: {
            id: 'perm-profile-undelivered',
            title: 'Update AGENTS.md',
            body: 's'.repeat(1000),
            requestContext: {
              requestId: 'perm-profile-undelivered',
              sourceAgentFolder: 'whatsapp_main',
              targetJid: 'tg:100200300',
              toolName: 'request_agent_profile_update',
            },
            files: [
              {
                path: 'AGENTS.md',
                preview: 'x'.repeat(7000),
                truncated: false,
                sizeBytes: 7000,
                contentHash: 'abc123',
              },
            ],
          },
        },
      );
      await flushPromises();

      const promptCall = currentBot().api.sendMessage.mock.calls.at(-1);
      expect(promptCall?.[0]).toBe('-100200300');
      expect(promptCall?.[1]).toContain(
        'Approval unavailable until the full details can be reviewed.',
      );
      expect(promptCall?.[2]).not.toHaveProperty('reply_markup');

      const decision = await decisionPromise;
      expect(decision.approved).toBe(false);
    });

    it('splits an oversized intent-only review prompt before sending the decision buttons', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const details = Array.from({ length: 90 }, (_, index) => ({
        label: `Field${index}`,
        value: 'v'.repeat(150),
      }));

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-mcp-large',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'request_mcp_server',
          title: 'Connect MCP',
          interaction: {
            id: 'perm-mcp-large',
            title: 'Connect MCP',
            body: 'short body',
            details,
            requestContext: {
              requestId: 'perm-mcp-large',
              sourceAgentFolder: 'whatsapp_main',
              targetJid: 'tg:100200300',
              toolName: 'request_mcp_server',
            },
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
      expect(currentBot().api.sendDocument).not.toHaveBeenCalled();
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
        callbackQuery: { data: latestPermissionCallback('Allow once') },
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
      expect(callbackData).toMatch(
        /^perm:allow_once:[0-9a-f]{8}-[0-9a-f-]{27}$/,
      );
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
        decidedBy: '12345',
        mode: 'allow_once',
        decisionClassification: 'user_temporary',
        permissionCallbackClaim: {
          id: expect.any(String),
          scope: {
            appId: 'default',
            sourceAgentFolder: 'whatsapp_main',
            interactionId:
              'capability-request_permission-0faf53fe-39cd-4ef0-af6e-5e09b96eef53',
          },
        },
        reason: 'allowed once via Telegram',
      });
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Allowed once.',
      });
      expect(currentBot().api.deleteMessage).toHaveBeenCalledWith(
        '100200300',
        987,
      );
      expect(currentBot().api.editMessageText).not.toHaveBeenCalled();
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
        callbackQuery: { data: latestPermissionCallback('Allow once') },
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
        callbackQuery: { data: latestPermissionCallback('Allow once') },
        chat: { id: 100200300 },
        from: { id: 444, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(approvedCtx);
      const decision = await decisionPromise;
      expect(decision.approved).toBe(true);
      expect(decision.decidedBy).toBe('444');
    });

    it('edits an approval receipt when Telegram prompt deletion fails', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.deleteMessage.mockRejectedValueOnce(
        new Error('message cannot be deleted'),
      );

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-delete-fallback',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Bash',
          title: 'Allow command',
        },
      );
      await flushPromises();
      const callbackData =
        currentBot().api.sendMessage.mock.calls.at(-1)?.[2].reply_markup
          .inline_keyboard[0][0].callback_data;
      await triggerCallbackQuery({
        callbackQuery: { data: callbackData },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });

      await expect(decisionPromise).resolves.toMatchObject({ approved: true });
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        987,
        expect.stringContaining('Allowed once:'),
        expect.objectContaining({ reply_markup: { inline_keyboard: [] } }),
      );
    });

    it('sends an approval receipt when Telegram prompt deletion and edit fail', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.deleteMessage.mockRejectedValueOnce(
        new Error('message cannot be deleted'),
      );
      currentBot().api.editMessageText.mockRejectedValueOnce(
        new Error('message cannot be edited'),
      );

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-edit-fallback',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Bash',
          title: 'Allow command',
        },
      );
      await flushPromises();
      const callbackData =
        currentBot().api.sendMessage.mock.calls.at(-1)?.[2].reply_markup
          .inline_keyboard[0][0].callback_data;
      await triggerCallbackQuery({
        callbackQuery: { data: callbackData },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });

      await expect(decisionPromise).resolves.toMatchObject({ approved: true });
      expect(currentBot().api.sendMessage).toHaveBeenLastCalledWith(
        '100200300',
        expect.stringContaining('Allowed once:'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
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
        callbackQuery: { data: latestPermissionCallback('Allow once') },
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

    it('resolves a pending approval on disconnect after a retryable claim failure', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-disconnect-retryable',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Bash',
        },
      );
      await flushPromises();
      configurePendingInteractionDurability({
        repository: {
          claimPendingPermissionCallback: vi.fn(async () => {
            throw new Error('postgres unavailable');
          }),
        } as never,
      });

      await channel.disconnect();

      await expect(decisionPromise).resolves.toEqual({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'Telegram channel disconnected',
      });
      expect((channel as any).pendingPermissionPrompts.size).toBe(0);
    });

    it('resolves an ownerless Telegram permission waiter on disconnect', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-disconnect-ownerless',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Bash',
        },
      );
      await flushPromises();
      configurePendingInteractionDurability({
        repository: {
          claimPendingPermissionCallback: vi.fn(async () => []),
          findPendingPermissionInteractions: vi.fn(async () => []),
        } as never,
      });

      await channel.disconnect();

      await expect(decisionPromise).resolves.toEqual({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'Telegram channel disconnected',
      });
      expect((channel as any).pendingPermissionPrompts.size).toBe(0);
    });

    it('preserves a Telegram permission waiter owned by an in-flight winner on disconnect', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-disconnect-winner',
          sourceAgentFolder: 'whatsapp_main',
          toolName: 'Bash',
        },
      );
      await flushPromises();
      const scope = {
        appId: 'default',
        sourceAgentFolder: 'whatsapp_main',
        interactionId: 'perm-disconnect-winner',
      };
      configurePendingInteractionDurability({
        repository: {
          claimPendingPermissionCallback: vi.fn(async () => []),
          findPendingPermissionInteractions: vi.fn(async () => [
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
                    canonicalId: 'perm-disconnect-winner',
                    providerAliases: [],
                  },
                },
              },
            },
          ]),
        } as never,
      });
      let resolved = false;
      void decisionPromise.then(() => {
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
      pending.resolve({
        approved: true,
        mode: 'allow_once',
        decidedBy: 'owner',
      });
      prompts.clear();
      await decisionPromise;
    });

    it('drops matching Telegram permission and question waiters without resolving them', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const permissionRequest = {
        requestId: 'permission-drop-shadow',
        sourceAgentFolder: 'whatsapp_main',
        targetJid: 'tg:100200300',
        toolName: 'Bash',
      };
      const questionRequest = {
        requestId: 'question-drop-shadow',
        sourceAgentFolder: 'whatsapp_main',
        targetJid: 'tg:100200300',
        questions: [
          {
            question: 'Continue?',
            header: 'Continue',
            multiSelect: false,
            options: [{ label: 'Yes', description: 'Continue' }],
          },
        ],
      };
      const approval = channel.requestPermissionApproval(
        'tg:100200300',
        permissionRequest,
      );
      const answer = channel.requestUserAnswer('tg:100200300', questionRequest);
      let resolved = 0;
      void approval.then(() => {
        resolved += 1;
      });
      void answer.then(() => {
        resolved += 1;
      });
      await flushPromises();

      channel.dropPendingInteraction('permission', permissionRequest);
      channel.dropPendingInteraction('question', questionRequest);
      await Promise.resolve();

      expect((channel as any).pendingPermissionPrompts.size).toBe(0);
      expect((channel as any).pendingUserQuestions.size).toBe(0);
      expect((channel as any).pendingUserQuestionCallbackIds.size).toBe(0);
      expect(resolved).toBe(0);
      await channel.disconnect();
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
        expect(decision).toMatchObject({
          approved: false,
          decidedBy: 'system',
          reason: 'timed out',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves the Telegram waiter after retryable timeout claims exhaust bounded retries', async () => {
      vi.useFakeTimers();
      try {
        const channel = new TelegramChannel('test-token', createTestOpts());
        await channel.connect();
        const decisionPromise = channel.requestPermissionApproval(
          'tg:100200300',
          {
            requestId: 'perm-timeout-retryable',
            sourceAgentFolder: 'whatsapp_main',
            toolName: 'Edit',
          },
        );
        await vi.advanceTimersByTimeAsync(0);
        expect((channel as any).pendingPermissionPrompts.size).toBe(1);
        const claimPendingPermissionCallback = vi.fn(async () => {
          throw new Error('postgres unavailable');
        });
        configurePendingInteractionDurability({
          repository: { claimPendingPermissionCallback } as never,
        });

        await vi.advanceTimersByTimeAsync(600_000);

        await expect(decisionPromise).resolves.toMatchObject({
          approved: false,
          mode: 'cancel',
          decidedBy: 'system',
          reason: 'timed out',
        });
        expect(claimPendingPermissionCallback).toHaveBeenCalledTimes(3);
        expect((channel as any).pendingPermissionPrompts.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('user question prompts', () => {
    it('creates unique opaque callback ids within Telegram limits', () => {
      const first = telegramQuestionCallbackId();

      expect(telegramQuestionCallbackId()).not.toBe(first);
      expect(
        Buffer.byteLength(`userq:select:${first}:999`, 'utf8'),
      ).toBeLessThanOrEqual(64);
    });

    it('does not deliver a question when its durable callback binding fails', async () => {
      vi.useFakeTimers();
      const pending = {
        kind: 'question' as const,
        status: 'pending' as const,
        idempotencyKey: 'default:question:whatsapp_main:userq-bind-failure',
        payload: {
          sourceAgentFolder: 'whatsapp_main',
          requestId: 'userq-bind-failure',
        },
      };
      configurePendingInteractionDurability({
        repository: {
          listPendingInteractions: vi.fn(async () => [pending]),
          updatePendingInteractionPayload: vi.fn(async () => false),
        } as never,
      });
      telegramPromptBindingBehavior.strict = true;
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.sendMessage.mockClear();

      const responsePromise = channel.requestUserAnswer('tg:100200300', {
        requestId: 'userq-bind-failure',
        sourceAgentFolder: 'whatsapp_main',
        questions: [
          {
            question: 'Continue?',
            header: 'Confirm',
            options: [{ label: 'Yes', description: 'Continue' }],
            multiSelect: false,
          },
        ],
      });
      await vi.runAllTimersAsync();

      await expect(responsePromise).resolves.toEqual({
        requestId: 'userq-bind-failure',
        answers: {},
      });
      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

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
        Array<{ text: string; callback_data: string }>
      >;
      const optionButtonTexts = keyboard.slice(0, 2).map((row) => row[0].text);

      expect(optionButtonTexts[0]).toMatch(/^1\. /);
      expect(optionButtonTexts[1]).toMatch(/^2\. /);
      optionButtonTexts.forEach((text) => {
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(56);
      });
      const callbackData = keyboard[0][0].callback_data;
      expect(callbackData).toMatch(/^userq:select:q[A-Za-z0-9_-]+:0$/);
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);

      await triggerCallbackQuery({
        callbackQuery: { data: callbackData },
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
        callbackQuery: {
          data: latestTelegramUserQuestionCallbackData('select', 1),
        },
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
        callbackQuery: {
          data: latestTelegramUserQuestionCallbackData('select', 0),
        },
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
        callbackQuery: {
          data: latestTelegramUserQuestionCallbackData('select', 1),
        },
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
        callbackQuery: {
          data: latestTelegramUserQuestionCallbackData('other'),
        },
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
        callbackQuery: {
          data: latestTelegramUserQuestionCallbackData('select', 0),
        },
        chat: { id: 100200300 },
        from: { id: 333, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await triggerCallbackQuery({
        callbackQuery: {
          data: latestTelegramUserQuestionCallbackData('select', 2),
        },
        chat: { id: 100200300 },
        from: { id: 333, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await triggerCallbackQuery({
        callbackQuery: {
          data: latestTelegramUserQuestionCallbackData('done'),
        },
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

    it('preserves pending Telegram multi-select answers on disconnect', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      const response = channel.requestUserAnswer('tg:100200300', {
        requestId: 'userq-disconnect-partial',
        sourceAgentFolder: 'whatsapp_main',
        questions: [
          {
            question: 'Which checks?',
            header: 'Checks',
            options: [
              { label: 'Build', description: 'Compile' },
              { label: 'Unit tests', description: 'Test' },
              { label: 'Integration', description: 'End to end' },
            ],
            multiSelect: true,
          },
        ],
      });
      await flushPromises();
      const pending = [...(channel as any).pendingUserQuestions.values()][0];
      pending.selectedOptionIndexes.add(2);
      pending.selectedOptionIndexes.add(0);

      await channel.disconnect();

      await expect(response).resolves.toEqual({
        requestId: 'userq-disconnect-partial',
        answers: { 'Which checks?': ['Build', 'Integration'] },
        answeredBy: 'system',
      });
    });

    it('persists Telegram timeout completion with an empty answer', async () => {
      vi.useFakeTimers();
      try {
        const interactions = telegramPromptBindingBehavior.interactions;
        const repository = {
          ...permissionClaimRepository(interactions),
          listPendingInteractions: vi.fn(async () => interactions),
          updatePendingInteractionPayload: vi.fn((input) =>
            updatePendingInteractionPayload(interactions, input),
          ),
          resolvePendingInteraction: vi.fn(async () => true),
        };
        configurePendingInteractionDurability({
          repository: repository as never,
        });
        const channel = new TelegramChannel('test-token', createTestOpts());
        await channel.connect();
        const response = channel.requestUserAnswer('tg:100200300', {
          requestId: 'userq-timeout-persisted',
          sourceAgentFolder: 'whatsapp_main',
          questions: [
            {
              question: 'Will timeout',
              header: 'Wait',
              options: [{ label: 'Continue', description: 'Proceed' }],
              multiSelect: false,
            },
          ],
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(300000);

        await expect(response).resolves.toMatchObject({ answers: {} });
        const interaction = interactions.find(
          (candidate) => candidate.kind === 'question',
        );
        expect(interaction.payload.questionRecoveryEnvelope).toMatchObject({
          answers: { 'Will timeout': '' },
          completedQuestionIndexes: [0],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('propagates Telegram question delivery persistence failure', async () => {
      telegramPromptBindingBehavior.strict = true;
      const interactions = telegramPromptBindingBehavior.interactions;
      let updates = 0;
      const repository = {
        ...permissionClaimRepository(interactions),
        listPendingInteractions: vi.fn(async () => interactions),
        updatePendingInteractionPayload: vi.fn(async (input) => {
          updates += 1;
          if (updates === 2) throw new Error('write failed');
          return await updatePendingInteractionPayload(interactions, input);
        }),
        resolvePendingInteraction: vi.fn(async () => true),
      };
      configurePendingInteractionDurability({
        repository: repository as never,
      });
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      await expect(
        channel.requestUserAnswer('tg:100200300', {
          requestId: 'userq-persist-failure',
          sourceAgentFolder: 'whatsapp_main',
          questions: [
            {
              question: 'Must persist?',
              header: 'Persist',
              options: [{ label: 'Yes', description: 'Continue' }],
              multiSelect: false,
            },
          ],
        }),
      ).rejects.toMatchObject({ name: 'DurableInteractionPersistenceError' });
      for (const pending of (channel as any).pendingUserQuestions.values()) {
        clearTimeout(pending.timer);
      }
      (channel as any).pendingUserQuestions.clear();
      (channel as any).pendingUserQuestionCallbackIds.clear();
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
          data: latestPermissionCallback('Allow once'),
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
          decidedBy: '777',
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
  it('returns null when TELEGRAM_BOT_TOKEN is not set', async () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const result = await createTelegramChannel({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        conversationRoutes: () => ({}),
        runtimeSecrets: new EnvRuntimeSecretProvider(),
      });
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Telegram: TELEGRAM_BOT_TOKEN not set',
      );
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });

  it('returns a TelegramChannel when Provider Account refs point at env token', async () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-from-env';
    try {
      const result = await createTelegramChannel({
        ...createTestOpts(),
        runtimeSecrets: new EnvRuntimeSecretProvider(),
      });
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(TelegramChannel);
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved;
      else delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it('returns a TelegramChannel from configured runtime secret refs', async () => {
    const result = await createTelegramChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      providerAccountId: 'telegram_default',
      conversationRoutes: () => ({}),
      runtimeSettings: () =>
        ({
          providers: { telegram: { enabled: true } },
          providerAccounts: {
            telegram_default: {
              agentId: 'default',
              provider: 'telegram',
              label: 'Telegram',
              runtimeSecretRefs: {
                bot_token: 'gantry-secret:TELEGRAM_BOT_TOKEN',
              },
            },
          },
        }) as never,
      runtimeSecrets: {
        getSecret: vi.fn(),
        getOptionalSecret: vi.fn(),
        getOptionalSecretAsync: vi.fn(async (ref) =>
          ref.ref === 'gantry-secret:TELEGRAM_BOT_TOKEN'
            ? 'test-token-from-store'
            : undefined,
        ),
      },
    });

    expect(result).toBeInstanceOf(TelegramChannel);
  });
});
