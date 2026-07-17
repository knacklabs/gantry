import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/platform/sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn(() => ({})),
  loadSenderControlAllowlist: vi.fn(() => ({})),
  shouldDropMessage: vi.fn(() => false),
  isSenderAllowed: vi.fn(() => true),
  isSenderControlAllowed: vi.fn(() => true),
  shouldLogDenied: vi.fn(() => false),
}));

const runtimeStoreMock = vi.hoisted(() => ({
  opsRepository: {
    storeMessage: vi.fn(async () => undefined),
    storeChatMetadata: vi.fn(async () => undefined),
  },
  repositories: {
    agents: {},
    providerAccounts: {
      getProviderAccount: vi.fn(async () => null),
      saveConversationInstall: vi.fn(async () => undefined),
      listConversationInstalls: vi.fn(async () => []),
      listConversationInstallsByConversation: vi.fn(async () => []),
      getConversationInstall: vi.fn(async () => null),
    },
    conversations: {
      getConversation: vi.fn(async () => null),
      getConversationByExternalRef: vi.fn(async () => null),
      listConversationApprovers: vi.fn(async () => []),
      listParticipantExternalUserIds: vi.fn(async () => []),
    },
  },
}));
const runtimeLeaseMock = vi.hoisted(() => ({
  tryAcquire: vi.fn(async () => ({
    onLost: vi.fn(),
    release: vi.fn(async () => undefined),
  })),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ repositories: runtimeStoreMock.repositories }),
  getRuntimeRepositories: () => runtimeStoreMock.opsRepository,
  tryAcquireRuntimeAdvisoryLease: runtimeLeaseMock.tryAcquire,
}));

import { RuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { ChannelAdapter } from '@core/channels/channel-provider.js';
import { Provider } from '@core/channels/provider-registry.js';
import { AsyncTaskQueue } from '@core/app/bootstrap/async-task-queue.js';
import { createChannelPersistenceHandlers } from '@core/app/bootstrap/channel-persistence-handlers.js';
import { hydrateChannelConversationContext } from '@core/app/bootstrap/channel-wiring-conversation-context.js';
import { createChannelWiring } from '@core/app/bootstrap/channel-wiring.js';
import {
  createAgentTodoRenderer,
  createRichInteractionRenderer,
  createUserQuestionResponder,
} from '@core/app/bootstrap/channel-wiring-interactions.js';
import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
import { decisionForMode } from '@core/channels/permission-interaction.js';
import { DurableInteractionPersistenceError } from '@core/application/interactions/pending-interaction-durability.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { PartialMessageDeliveryError } from '@core/domain/messages/partial-delivery.js';
import { AmbiguousDurableDeliveryError } from '@core/domain/messages/durable-delivery.js';
import {
  RICH_INTERACTION_NATIVE_FALLBACK_TEXT,
  type PermissionApprovalRequest,
  type UserQuestionRequest,
} from '@core/domain/types.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

function makeRuntimeSettings(enabled: {
  telegram: boolean;
  slack: boolean;
}): RuntimeSettings {
  const allowlist = {
    default: { allow: '*', mode: 'trigger' as const },
    agents: {},
    logDenied: true,
  };
  return {
    providers: {
      telegram: { enabled: enabled.telegram },
      slack: { enabled: enabled.slack },
    },
    providerAccounts: {
      ...(enabled.telegram
        ? {
            telegram_default: {
              agentId: 'agent:main_agent',
              provider: 'telegram',
              label: 'Telegram',
              runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
            },
          }
        : {}),
      ...(enabled.slack
        ? {
            slack_default: {
              agentId: 'agent:main_agent',
              provider: 'slack',
              label: 'Slack',
              runtimeSecretRefs: {
                bot_token: 'env:SLACK_BOT_TOKEN',
                app_token: 'env:SLACK_APP_TOKEN',
              },
            },
          }
        : {}),
    },
    memory: {
      enabled: true,
      embeddings: {
        enabled: false,
        provider: 'disabled',
        model: 'text-embedding-3-small',
      },
      dreaming: {
        enabled: false,
      },
      llm: {
        models: {
          extractor: 'haiku',
          dreaming: 'sonnet',
          consolidation: 'sonnet',
        },
      },
    },
    runtime: {
      queue: {
        maxMessageRuns: 3,
        maxJobRuns: 4,
        maxRetries: 5,
        baseRetryMs: 5000,
      },
      liveTurns: {
        enabled: true,
        hostLeaseTtlMs: 30_000,
        hostLeaseRenewMs: 10_000,
        heartbeatMs: 10_000,
        leaseTtlMs: 30_000,
        maxRunMs: 3_600_000,
      },
    },
  };
}

function makeChannel(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: 'telegram',
    connect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid.startsWith('tg:')),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeApp(conversationRoutes: Record<string, any> = {}): RuntimeApp {
  return {
    queue: {} as RuntimeApp['queue'],
    loadState: vi.fn(),
    saveState: vi.fn(),
    getOrRecoverCursor: vi.fn(),
    registerGroup: vi.fn(async (jid: string, group: any) => {
      conversationRoutes[jid] = group;
    }),
    projectConversationRoute: vi.fn(async (jid: string, group: any) => {
      conversationRoutes[jid] = group;
    }),
    unregisterConversationRoute: vi.fn(async (jid: string) => {
      delete conversationRoutes[jid];
    }),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    setConversationRoutesForTest: vi.fn(),
    ensureCredentialBindingsForConversationRoutes: vi.fn(),
    processGroupMessages: vi.fn(),
    getConversationRoutes: vi.fn(() => conversationRoutes),
    setAgentCursor: vi.fn(),
    setChannelRuntime: vi.fn(),
  };
}

function makeProvider(
  id: Provider['id'],
  create: Provider['create'],
  overrides: Partial<Provider> = {},
): Provider {
  return {
    id,
    label: id,
    jidPrefix: id === 'telegram' ? 'tg:' : 'sl:',
    folderPrefix: `${id}_`,
    isGroupJid: (jid: string) =>
      id === 'telegram' ? jid.startsWith('tg:-') : jid.startsWith('sl:'),
    canStreamToJid:
      id === 'telegram' ? (jid: string) => jid.startsWith('tg:-') : undefined,
    formatting: id === 'telegram' ? 'telegram-html' : 'mrkdwn',
    isEnabled: (settings: RuntimeSettings) =>
      id === 'telegram'
        ? settings.providers.telegram.enabled
        : settings.providers.slack.enabled,
    create,
    setup: {
      envKeys: [],
      describe: () => id,
      run: async () => {},
    },
    ...overrides,
  };
}

describe('createChannelWiring', () => {
  it('coalesces run permission requests into one live batch prompt', async () => {
    vi.useFakeTimers();
    try {
      const resetStreaming = vi.fn();
      const requestPermissionApproval = vi.fn(
        async (
          _jid: string,
          request: PermissionApprovalRequest,
          onPromptDelivered?: (messageId: string) => void,
        ) => {
          onPromptDelivered?.('batch-prompt-1');
          return {
            approved: true,
            mode: 'allow_once' as const,
            decidedBy: 'Ravi',
          };
        },
      );
      const requester = createPermissionApprovalRequester({
        findBoundChannel: () => ({}),
        asPermissionApprovalSurface: () => ({ requestPermissionApproval }),
        interactionLifecycle: { logger: { error: vi.fn() }, resetStreaming },
      });
      const base = {
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:team',
        runId: 'run-1',
        decisionPolicy: 'same_channel' as const,
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      };

      const first = requester({ ...base, requestId: 'permission-1' });
      const second = requester({ ...base, requestId: 'permission-2' });
      await vi.advanceTimersByTimeAsync(1500);

      expect(requestPermissionApproval).toHaveBeenCalledOnce();
      expect(requestPermissionApproval.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          title: 'Review 2 permission requests',
          decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
        }),
      );
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ approved: true, mode: 'allow_once' }),
        expect.objectContaining({ approved: true, mode: 'allow_once' }),
      ]);
      expect(resetStreaming).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves Review each when a provider overwrites the decision reason', async () => {
    vi.useFakeTimers();
    try {
      const requestPermissionApproval = vi.fn(
        async (
          _jid: string,
          request: PermissionApprovalRequest,
          onPromptDelivered?: (messageId: string) => void,
        ) => {
          onPromptDelivered?.(`prompt-${request.requestId}`);
          if (request.permissionBatch) {
            return {
              ...decisionForMode(request, 'allow_persistent_rule', 'Ravi'),
              reason: 'persistent rule allowed via Telegram',
            };
          }
          return request.requestId === 'permission-1'
            ? {
                approved: true,
                mode: 'allow_once' as const,
                decidedBy: 'Ravi',
              }
            : {
                approved: false,
                mode: 'cancel' as const,
                decidedBy: 'Ravi',
              };
        },
      );
      const requester = createPermissionApprovalRequester({
        findBoundChannel: () => ({}),
        asPermissionApprovalSurface: () => ({ requestPermissionApproval }),
        interactionLifecycle: { logger: { error: vi.fn() } },
      });
      const base = {
        sourceAgentFolder: 'main_agent',
        targetJid: 'tg:team',
        runId: 'run-1',
        decisionPolicy: 'same_channel' as const,
        toolName: 'Bash',
      };

      const first = requester({ ...base, requestId: 'permission-1' });
      const second = requester({ ...base, requestId: 'permission-2' });
      await vi.advanceTimersByTimeAsync(1500);

      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ approved: true, mode: 'allow_once' }),
        expect.objectContaining({ approved: false, mode: 'cancel' }),
      ]);
      expect(requestPermissionApproval).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets streaming only after interactive prompts are delivered', async () => {
    const resetPermissionStreaming = vi.fn();
    const permissionRequester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: vi.fn(
          async (_jid, _request, onPromptDelivered) => {
            onPromptDelivered?.('permission-prompt-1');
            return { approved: false, mode: 'cancel' };
          },
        ),
      }),
      interactionLifecycle: {
        logger: { error: vi.fn() },
        resetStreaming: resetPermissionStreaming,
      },
    });
    await permissionRequester({
      requestId: 'permission-reset',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:team',
      providerAccountId: 'telegram_alpha',
      threadId: 'topic-7',
      toolName: 'Bash',
    });
    expect(resetPermissionStreaming).toHaveBeenCalledWith(
      'tg:team',
      expect.objectContaining({
        providerAccountId: 'telegram_alpha',
        threadId: 'topic-7',
      }),
    );

    const resetQuestionStreaming = vi.fn();
    const responder = createUserQuestionResponder({
      findBoundChannel: () => ({}),
      asUserQuestionSurface: () => ({
        requestUserAnswer: vi.fn(async (_jid, request, onPromptDelivered) => {
          onPromptDelivered?.('question-prompt-1');
          return { requestId: request.requestId, answers: {} };
        }),
      }),
      interactionLifecycle: {
        logger: { debug: vi.fn(), error: vi.fn() },
        resetStreaming: resetQuestionStreaming,
      },
    });
    await responder.requestUserAnswer({
      requestId: 'question-reset',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:team',
      providerAccountId: 'telegram_alpha',
      threadId: 'topic-9',
      questions: [],
    });
    expect(resetQuestionStreaming).toHaveBeenCalledWith(
      'tg:team',
      expect.objectContaining({
        providerAccountId: 'telegram_alpha',
        threadId: 'topic-9',
      }),
    );

    const missingReset = vi.fn();
    const missingRequester = createPermissionApprovalRequester({
      findBoundChannel: () => undefined,
      asPermissionApprovalSurface: () => undefined,
      interactionLifecycle: {
        logger: { error: vi.fn() },
        resetStreaming: missingReset,
      },
    });
    await missingRequester({
      requestId: 'permission-missing',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:missing',
      toolName: 'Bash',
    });
    expect(missingReset).not.toHaveBeenCalled();
  });

  it('drops a shadowing question waiter before rethrowing its persistence error', async () => {
    const events: string[] = [];
    const persistenceError = new DurableInteractionPersistenceError(
      'question prompt delivery was not persisted',
    );
    const dropPendingInteraction = vi.fn(() => events.push('drop'));
    const responder = createUserQuestionResponder({
      findBoundChannel: () => ({}),
      asUserQuestionSurface: () => ({
        requestUserAnswer: vi.fn(async () => {
          events.push('request');
          throw persistenceError;
        }),
        dropPendingInteraction,
      }),
      interactionLifecycle: {
        logger: { debug: vi.fn(), error: vi.fn() },
      },
    });
    const request: UserQuestionRequest = {
      requestId: 'question-persistence-failure',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:team',
      questions: [],
    };

    const response = responder.requestUserAnswer(request).catch((err) => {
      events.push('reject');
      throw err;
    });

    await expect(response).rejects.toBe(persistenceError);
    expect(dropPendingInteraction).toHaveBeenCalledWith('question', request);
    expect(events).toEqual(['request', 'drop', 'reject']);
  });

  it('does not bypass provider-owned claim settlement when an approval surface remains pending', async () => {
    vi.useFakeTimers();
    try {
      const requestPermissionApproval = createPermissionApprovalRequester({
        findBoundChannel: () => ({}),
        asPermissionApprovalSurface: () => ({
          requestPermissionApproval: vi.fn(() => new Promise(() => undefined)),
        }),
        interactionLifecycle: { logger: { error: vi.fn() } },
      });

      const decisionPromise = requestPermissionApproval({
        requestId: 'perm-1',
        sourceAgentFolder: 'team',
        targetJid: 'tg:team',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      });
      let settled = false;
      void decisionPromise.finally(() => {
        settled = true;
      });
      await vi.runAllTimersAsync();

      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes rich interactions to a bound channel surface', async () => {
    const renderRichInteraction = vi.fn(async () => true);
    const sendMessage = vi.fn();
    const channel = { renderRichInteraction };
    const renderer = createRichInteractionRenderer({
      findBoundChannel: () => channel,
      asRichInteractionSurface: () => channel,
      sendMessage,
      logger: { error: vi.fn() },
    });

    await expect(
      renderer('tg:team', {
        requestId: 'rich-1',
        sourceAgentFolder: 'team',
        targetJid: 'tg:team',
        descriptor: {
          id: 'status',
          title: 'Status',
          fallbackText: 'Status: ready',
          rich: {
            kind: 'status',
            fallbackText: 'Status: ready',
            payload: { state: 'ready' },
          },
        },
      }),
    ).resolves.toBe(true);

    expect(renderRichInteraction).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('falls back rich interactions when the channel has no rich surface', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const renderer = createRichInteractionRenderer({
      findBoundChannel: () => ({}),
      asRichInteractionSurface: () => undefined,
      sendMessage,
      logger: { error: vi.fn() },
    });

    await expect(
      renderer('tg:team', {
        requestId: 'rich-2',
        sourceAgentFolder: 'team',
        targetJid: 'tg:team',
        threadId: 'thread-1',
        descriptor: {
          id: 'status',
          title: 'Status',
          fallbackText: 'Status: blocked',
          rich: {
            kind: 'status',
            fallbackText: 'Status: blocked',
            payload: { state: 'blocked' },
          },
        },
      }),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:team',
      `${RICH_INTERACTION_NATIVE_FALLBACK_TEXT}\n\nStatus: blocked`,
      { threadId: 'thread-1' },
    );
  });

  it('keeps the resolved provider account on rich interaction fallback sends', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const renderer = createRichInteractionRenderer({
      findBoundChannel: () => ({}),
      asRichInteractionSurface: () => undefined,
      sendMessage,
      logger: { error: vi.fn() },
    });

    await renderer(
      'tg:team',
      {
        requestId: 'rich-3',
        sourceAgentFolder: 'team',
        targetJid: 'tg:team',
        providerAccountId: 'telegram_default',
        descriptor: {
          id: 'status',
          title: 'Status',
          fallbackText: 'Status: blocked',
        },
      },
      { providerAccountId: 'telegram_override' },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:team',
      `${RICH_INTERACTION_NATIVE_FALLBACK_TEXT}\n\nStatus: blocked`,
      { providerAccountId: 'telegram_override' },
    );
  });

  it('skips disabled channels in runtime settings', async () => {
    const app = makeApp();
    const info = vi.fn();

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => makeChannel()),
        ),
        makeProvider(
          'slack',
          vi.fn(() => makeChannel()),
        ),
      ],
      logger: {
        info,
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: false }),
    );

    expect(wiring.hasConnectedChannels()).toBe(false);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('warns and skips when credentials are missing', async () => {
    const app = makeApp();
    const warn = vi.fn();

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => null),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn,
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    expect(wiring.hasConnectedChannels()).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('connects channels without inbound messages or callbacks when live turns are disabled', async () => {
    const app = makeApp();
    const channel = makeChannel();
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });
    const settings = makeRuntimeSettings({ telegram: true, slack: false });
    settings.runtime.liveTurns.enabled = false;

    await wiring.connectEnabledChannels(settings);

    expect(channel.connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
  });

  it('connects outbound-only when the process role has no provider inbound', async () => {
    const app = makeApp();
    const channel = makeChannel();
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });
    // Live turns enabled globally, but the role (control/job-worker) forbids
    // inbound: channels still connect, but outbound-only.
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
      { providerInbound: false },
    );

    expect(channel.connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
  });

  it('connects with inbound when the role admits provider inbound', async () => {
    const app = makeApp();
    const channel = makeChannel();
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
      { providerInbound: true },
    );

    expect(channel.connect).toHaveBeenCalledWith({
      inbound: true,
      interactionCallbacks: true,
    });
  });

  it('derives provider account and agent context for same-channel approval checks', async () => {
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValue(
      {
        id: 'conversation:app:D123',
        appId: 'default',
        providerAccountId: 'app_default',
        kind: 'direct',
        status: 'active',
      },
    );
    runtimeStoreMock.repositories.providerAccounts.getProviderAccount.mockResolvedValue(
      {
        id: 'app_default',
        appId: 'default',
        providerId: 'app',
      },
    );
    runtimeStoreMock.repositories.providerAccounts.getConversationInstall.mockResolvedValue(
      { status: 'active' },
    );
    runtimeStoreMock.repositories.conversations.listConversationApprovers.mockResolvedValue(
      [{ externalUserId: 'UADMIN' }],
    );
    runtimeStoreMock.repositories.conversations.listParticipantExternalUserIds.mockResolvedValue(
      ['UADMIN'],
    );
    const wiring = createChannelWiring(
      makeApp({
        'app:D123': {
          name: 'Main Agent DM',
          folder: 'main_agent',
          agentId: 'agent:main_agent',
          providerAccountId: 'app_default',
        },
      }),
    );

    await expect(
      wiring.isControlApproverAllowed({
        conversationJid: 'app:D123',
        userId: 'UADMIN',
        sourceAgentFolder: 'main_agent',
        decisionPolicy: 'same_channel',
      }),
    ).resolves.toBe(true);
  });

  it('carries approval thread context into conversation install lookup', async () => {
    runtimeStoreMock.repositories.providerAccounts.getConversationInstall.mockClear();
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValue(
      {
        id: 'conversation:app:D123',
        appId: 'default',
        providerAccountId: 'app_default',
        kind: 'direct',
        status: 'active',
      },
    );
    runtimeStoreMock.repositories.providerAccounts.getProviderAccount.mockResolvedValue(
      {
        id: 'app_default',
        appId: 'default',
        providerId: 'app',
      },
    );
    runtimeStoreMock.repositories.providerAccounts.getConversationInstall.mockResolvedValue(
      { status: 'active' },
    );
    runtimeStoreMock.repositories.conversations.listConversationApprovers.mockResolvedValue(
      [{ externalUserId: 'UADMIN' }],
    );
    runtimeStoreMock.repositories.conversations.listParticipantExternalUserIds.mockResolvedValue(
      ['UADMIN'],
    );
    const wiring = createChannelWiring(
      makeApp({
        [makeAgentThreadQueueKey(
          'app:D123',
          'agent:main_agent',
          'thread-1',
          'app_default',
        )]: {
          name: 'Thread Install',
          folder: 'main_agent',
          agentId: 'agent:main_agent',
          providerAccountId: 'app_default',
          threadId: 'thread-1',
        },
      }),
    );

    await expect(
      wiring.isControlApproverAllowed({
        conversationJid: 'app:D123',
        threadId: 'thread-1',
        userId: 'UADMIN',
        sourceAgentFolder: 'main_agent',
        decisionPolicy: 'same_channel',
      }),
    ).resolves.toBe(true);
    expect(
      runtimeStoreMock.repositories.providerAccounts.getConversationInstall,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread:app_default:app:D123:thread-1',
      }),
    );
  });

  it('fails closed when same-channel approval context cannot be resolved', async () => {
    runtimeStoreMock.repositories.providerAccounts.getConversationInstall.mockClear();
    const wiring = createChannelWiring(makeApp());

    await expect(
      wiring.isControlApproverAllowed({
        conversationJid: 'app:D404',
        userId: 'UADMIN',
        sourceAgentFolder: 'main_agent',
        decisionPolicy: 'same_channel',
      }),
    ).resolves.toBe(false);
    expect(
      runtimeStoreMock.repositories.providerAccounts.getConversationInstall,
    ).not.toHaveBeenCalled();
  });

  it('starts one channel adapter per active Provider Account', async () => {
    const app = makeApp();
    const create = vi
      .fn()
      .mockImplementation(() => makeChannel({ name: 'slack' }));
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        runtimeSecretRefs: {},
      },
      slack_beta: {
        agentId: 'agent:beta',
        provider: 'slack',
        label: 'Beta Slack',
        runtimeSecretRefs: {},
      },
    };
    const wiring = createChannelWiring(app, {
      providerIds: [makeProvider('slack', create)],
    });

    await wiring.connectEnabledChannels(settings, { providerInbound: true });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map(([opts]) => opts.providerAccountId)).toEqual([
      'slack_alpha',
      'slack_beta',
    ]);
    expect(create.mock.calls.map(([opts]) => opts.agentId)).toEqual([
      'agent:alpha',
      'agent:beta',
    ]);
  });

  it('starts internal app channel under the canonical control Provider Account', async () => {
    const create = vi.fn(() =>
      makeChannel({
        name: 'app',
        ownsJid: vi.fn((jid: string) => jid.startsWith('app:')),
      }),
    );
    const wiring = createChannelWiring(makeApp(), {
      providerIds: [
        makeProvider('app', create, {
          internal: true,
          jidPrefix: 'app:',
          isEnabled: () => true,
        }),
      ],
    });
    const settings = makeRuntimeSettings({ telegram: false, slack: false });
    settings.providerAccounts = {};

    await wiring.connectEnabledChannels(settings, { providerInbound: true });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: 'control:default',
        agentId: 'agent:main_agent',
      }),
    );
    expect(wiring.hasConnectedChannels()).toBe(true);
    expect(
      wiring.hasChannel('app:conversation', {
        providerAccountId: 'control:default',
      }),
    ).toBe(true);
  });

  it('skips disabled Provider Accounts', async () => {
    const app = makeApp();
    const create = vi.fn(() => makeChannel({ name: 'slack' }));
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'agent:alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        status: 'disabled',
        runtimeSecretRefs: {},
      },
    };
    const wiring = createChannelWiring(app, {
      providerIds: [makeProvider('slack', create)],
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    });

    await wiring.connectEnabledChannels(settings);

    expect(create).not.toHaveBeenCalled();
    expect(wiring.hasConnectedChannels()).toBe(false);
  });

  it('uses a singleton provider inbound lease in fleet mode', async () => {
    runtimeLeaseMock.tryAcquire.mockClear();
    const app = makeApp();
    const channel = makeChannel();
    const lease = {
      onLost: vi.fn(),
      release: vi.fn(async () => undefined),
    };
    runtimeLeaseMock.tryAcquire.mockResolvedValueOnce(lease);
    const settings = makeRuntimeSettings({ telegram: true, slack: false });
    settings.runtime.deploymentMode = 'fleet';
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
    });

    await wiring.connectEnabledChannels(settings, { providerInbound: true });

    expect(runtimeLeaseMock.tryAcquire).toHaveBeenCalledWith(
      'runtime:provider-inbound:telegram:telegram_default',
    );
    expect(channel.connect).toHaveBeenCalledWith({
      inbound: true,
      interactionCallbacks: true,
    });
    expect(lease.onLost).toHaveBeenCalledOnce();
  });

  it('connects fleet channels outbound-only when another worker owns provider inbound', async () => {
    runtimeLeaseMock.tryAcquire.mockClear();
    runtimeLeaseMock.tryAcquire.mockResolvedValueOnce(undefined);
    const app = makeApp();
    const channel = makeChannel();
    const settings = makeRuntimeSettings({ telegram: true, slack: false });
    settings.runtime.deploymentMode = 'fleet';
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
    });

    await wiring.connectEnabledChannels(settings, { providerInbound: true });

    expect(channel.connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
  });

  it('fails clearly when an enabled provider has only setup/discovery support', async () => {
    const app = makeApp();
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => null),
          {
            label: 'Teams',
            controlCapabilityFlags: [
              'setup',
              'discover',
              'runtime-placeholder',
            ],
          },
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    await expect(
      wiring.connectEnabledChannels(
        makeRuntimeSettings({ telegram: true, slack: false }),
      ),
    ).rejects.toThrow(/runtime transport is not implemented/);
  });

  it('drops disallowed inbound sender before persistence', async () => {
    const app = makeApp({
      'tg:123': {
        name: 'Main',
        folder: 'main',
        providerAccountId: 'telegram_default',
      },
    });
    const storeMessage = vi.fn(async () => {});
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: { storeMessage } as any,
      loadSenderAllowlist: vi.fn(() => ({}) as any),
      shouldDropMessage: vi.fn(() => true),
      isSenderAllowed: vi.fn(() => false),
      shouldLogDenied: vi.fn(() => true),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await onMessage?.('tg:123', {
      id: 'm1',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('stores normal inbound messages', async () => {
    const app = makeApp({
      'tg:123': {
        name: 'Main',
        folder: 'main',
        providerAccountId: 'telegram_default',
      },
    });
    const storeMessage = vi.fn(async () => {});
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: { storeMessage } as any,
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const msg = {
      id: 'm3',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    await onMessage?.('tg:123', msg);

    expect(storeMessage).toHaveBeenCalledWith({
      ...msg,
      agentId: 'agent:main_agent',
      providerAccountId: 'telegram_default',
    });
  });

  it('stores inbound messages with durable live admission when supported', async () => {
    const app = makeApp({
      'tg:123': {
        name: 'Main',
        folder: 'main_agent',
        providerAccountId: 'telegram_default',
        trigger: '@Main',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    const storeMessage = vi.fn(async () => {});
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      appId: 'app-one' as never,
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: {
        storeMessage,
        storeMessageWithLiveAdmission,
      } as any,
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const msg = {
      id: 'm-live-admission',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    await onMessage?.('tg:123', msg);

    expect(storeMessage).not.toHaveBeenCalled();
    expect(storeMessageWithLiveAdmission).toHaveBeenCalledWith(
      {
        ...msg,
        agentId: 'agent:main_agent',
        providerAccountId: 'telegram_default',
      },
      {
        appId: 'app-one',
        agentId: 'agent:main_agent',
        providerAccountId: 'telegram_default',
        triggerDecision: {
          source: 'channel_persistence',
          requiresTrigger: false,
          conversationKind: 'channel',
        },
      },
    );
  });

  it('fans one inbound provider message out to each selected agent route', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey('tg:123', 'agent:alpha')]: {
        name: 'Alpha',
        folder: 'alpha',
        providerAccountId: 'telegram_default',
        trigger: '@Alpha',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
      [makeAgentThreadQueueKey('tg:123', 'agent:beta')]: {
        name: 'Beta',
        folder: 'beta',
        providerAccountId: 'telegram_default',
        trigger: '@Beta',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
      },
    });
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      appId: 'app-one' as never,
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: {
        storeMessage: vi.fn(),
        storeMessageWithLiveAdmission,
      } as any,
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const msg = {
      id: 'm-live-admission',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    await onMessage?.('tg:123', msg);

    expect(storeMessageWithLiveAdmission).toHaveBeenCalledTimes(2);
    expect(
      storeMessageWithLiveAdmission.mock.calls.map((call) => call[1]),
    ).toEqual([
      expect.objectContaining({ agentId: 'agent:alpha' }),
      expect.objectContaining({ agentId: 'agent:beta' }),
    ]);
  });

  it('routes inbound provider messages only to the matching Provider Account', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: {
        name: 'Alpha',
        folder: 'alpha',
        providerAccountId: 'slack_alpha',
        agentId: 'agent:alpha',
        trigger: '@Alpha',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
      [makeAgentThreadQueueKey('sl:C123', 'agent:beta')]: {
        name: 'Beta',
        folder: 'beta',
        providerAccountId: 'slack_beta',
        agentId: 'agent:beta',
        trigger: '@Beta',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'agent:alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        runtimeSecretRefs: {},
      },
      slack_beta: {
        agentId: 'agent:beta',
        provider: 'slack',
        label: 'Beta Slack',
        runtimeSecretRefs: {},
      },
    };
    const wiring = createChannelWiring(app, {
      appId: 'app-one' as never,
      providerIds: [
        makeProvider('slack', (opts: any) => {
          if (opts.providerAccountId === 'slack_alpha')
            onMessage = opts.onMessage;
          return makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
          });
        }),
      ],
      opsRepository: {
        storeMessage: vi.fn(),
        storeMessageWithLiveAdmission,
      } as any,
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(settings);
    await onMessage?.('sl:C123', {
      id: 'm-account',
      chat_jid: 'sl:C123',
      sender: 'U1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(storeMessageWithLiveAdmission).toHaveBeenCalledOnce();
    expect(storeMessageWithLiveAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: 'slack_alpha' }),
      expect.objectContaining({
        agentId: 'agent:alpha',
        providerAccountId: 'slack_alpha',
      }),
    );
  });

  it('does not match key-scoped routes from a different Provider Account when the route payload is unscoped', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:beta',
        undefined,
        'slack_beta',
      )]: {
        name: 'Beta',
        folder: 'beta',
        agentId: 'agent:beta',
        trigger: '@Beta',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      ops: () =>
        ({
          storeMessage: vi.fn(),
          storeChatMetadata: vi.fn(),
          storeMessageWithLiveAdmission,
        }) as any,
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
    });

    await handlers.onMessage('sl:C123', {
      id: 'm-account-key-mismatch',
      chat_jid: 'sl:C123',
      providerAccountId: 'slack_alpha',
      sender: 'U1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(storeMessageWithLiveAdmission).not.toHaveBeenCalled();
  });

  it('does not match stale unscoped routes when inbound message has a Provider Account', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey('sl:C123', 'agent:beta')]: {
        name: 'Beta',
        folder: 'beta',
        agentId: 'agent:beta',
        trigger: '@Beta',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      ops: () =>
        ({
          storeMessage: vi.fn(),
          storeChatMetadata: vi.fn(),
          storeMessageWithLiveAdmission,
        }) as any,
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
    });

    await handlers.onMessage('sl:C123', {
      id: 'm-account-unscoped-route',
      chat_jid: 'sl:C123',
      providerAccountId: 'slack_alpha',
      sender: 'U1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(storeMessageWithLiveAdmission).not.toHaveBeenCalled();
  });

  it('falls back to a whole-conversation route for the message Provider Account before thread route precedence', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:alpha',
        undefined,
        'slack_alpha',
      )]: {
        name: 'Alpha',
        folder: 'alpha',
        providerAccountId: 'slack_alpha',
        agentId: 'agent:alpha',
        trigger: '@Alpha',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
      [makeAgentThreadQueueKey('sl:C123', 'agent:beta', 'T1', 'slack_beta')]: {
        name: 'Beta Thread',
        folder: 'beta',
        providerAccountId: 'slack_beta',
        agentId: 'agent:beta',
        trigger: '@Beta',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      ops: () =>
        ({
          storeMessage: vi.fn(),
          storeChatMetadata: vi.fn(),
          storeMessageWithLiveAdmission,
        }) as any,
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
    });

    await handlers.onMessage('sl:C123', {
      id: 'm-account-thread-fallback',
      chat_jid: 'sl:C123',
      providerAccountId: 'slack_alpha',
      thread_id: 'T1',
      sender: 'U1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(storeMessageWithLiveAdmission).toHaveBeenCalledOnce();
    expect(storeMessageWithLiveAdmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent:alpha',
        providerAccountId: 'slack_alpha',
      }),
    );
  });

  it('passes Provider Account id into channel context hydration lookup', async () => {
    const hydrateConversationContext = vi.fn(async () => ({
      providerId: 'slack',
      attempted: true,
      skipped: false,
      messages: [],
    }));
    const findBoundChannel = vi.fn(() => ({ hydrateConversationContext }));

    await hydrateChannelConversationContext(
      {
        conversationJid: 'sl:C123',
        providerAccountId: 'slack_beta',
        threadId: 'T1',
        limit: 10,
      },
      findBoundChannel,
      () => 'slack',
    );

    expect(findBoundChannel).toHaveBeenCalledWith('sl:C123', 'slack_beta');
  });

  it('resets the routed Provider Account channel after an IPC approval prompt', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:alpha',
        undefined,
        'slack_alpha',
      )]: {
        name: 'Alpha',
        folder: 'alpha',
        providerAccountId: 'slack_alpha',
        agentId: 'agent:alpha',
        trigger: '@Alpha',
        added_at: '2026-01-01T00:00:00.000Z',
        conversationKind: 'channel',
      },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:beta',
        undefined,
        'slack_beta',
      )]: {
        name: 'Beta',
        folder: 'beta',
        providerAccountId: 'slack_beta',
        agentId: 'agent:beta',
        trigger: '@Beta',
        added_at: '2026-01-01T00:00:00.000Z',
        conversationKind: 'channel',
      },
    });
    const alphaReset = vi.fn();
    const betaReset = vi.fn();
    const alphaApproval = vi.fn(
      async (
        _jid: string,
        _request: PermissionApprovalRequest,
        onPromptDelivered?: (messageId: string) => void,
      ) => {
        onPromptDelivered?.('alpha-prompt');
        return { approved: true };
      },
    );
    const betaApproval = vi.fn(
      async (
        _jid: string,
        _request: PermissionApprovalRequest,
        onPromptDelivered?: (messageId: string) => void,
      ) => {
        onPromptDelivered?.('beta-prompt');
        return { approved: false };
      },
    );
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'agent:alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        runtimeSecretRefs: {},
      },
      slack_beta: {
        agentId: 'agent:beta',
        provider: 'slack',
        label: 'Beta Slack',
        runtimeSecretRefs: {},
      },
    };
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) =>
          makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
            requestPermissionApproval:
              opts.providerAccountId === 'slack_alpha'
                ? alphaApproval
                : betaApproval,
            resetStreaming:
              opts.providerAccountId === 'slack_alpha' ? alphaReset : betaReset,
          }),
        ),
      ],
    });
    await wiring.connectEnabledChannels(settings);

    await expect(
      wiring.requestPermissionApproval({
        requestId: 'req-alpha',
        sourceAgentFolder: 'alpha',
        targetJid: 'sl:C123',
        threadId: 'thread-1',
        toolName: 'danger-tool',
      }),
    ).resolves.toEqual({ approved: true });
    expect(alphaApproval).toHaveBeenCalledOnce();
    expect(betaApproval).not.toHaveBeenCalled();
    expect(alphaReset).toHaveBeenCalledWith('sl:C123', {
      threadId: 'thread-1',
    });
    expect(betaReset).not.toHaveBeenCalled();
  });

  it('routes live UX methods through the requested Provider Account', async () => {
    const app = makeApp();
    const alpha = {
      resetStreaming: vi.fn(),
      setTyping: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      renderAgentTodo: vi.fn(async () => true),
      renderRichInteraction: vi.fn(async () => true),
    };
    const beta = {
      resetStreaming: vi.fn(),
      setTyping: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      renderAgentTodo: vi.fn(async () => true),
      renderRichInteraction: vi.fn(async () => true),
    };
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'agent:alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        runtimeSecretRefs: {},
      },
      slack_beta: {
        agentId: 'agent:beta',
        provider: 'slack',
        label: 'Beta Slack',
        runtimeSecretRefs: {},
      },
    };
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) =>
          makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
            ...(opts.providerAccountId === 'slack_alpha' ? alpha : beta),
          }),
        ),
      ],
    });
    await wiring.connectEnabledChannels(settings);

    const account = { providerAccountId: 'slack_beta' };
    wiring.resetStreaming('sl:C123', account);
    await wiring.setTyping('sl:C123', true, account);
    await wiring.addReaction('sl:C123', 'm-1', 'eyes', account);
    await wiring.renderAgentTodo(
      'sl:C123',
      { summary: null, items: [{ id: '1', title: 'Work', status: 'pending' }] },
      account,
    );
    await wiring.renderRichInteraction(
      'sl:C123',
      {
        requestId: 'rich-beta',
        sourceAgentFolder: 'beta',
        providerAccountId: 'slack_beta',
        targetJid: 'sl:C123',
        descriptor: {
          id: 'status',
          title: 'Status',
          fallbackText: 'ready',
          rich: { kind: 'status', fallbackText: 'ready', payload: {} },
        },
      },
      account,
    );

    expect(alpha.setTyping).not.toHaveBeenCalled();
    expect(alpha.resetStreaming).not.toHaveBeenCalled();
    expect(alpha.addReaction).not.toHaveBeenCalled();
    expect(alpha.renderAgentTodo).not.toHaveBeenCalled();
    expect(alpha.renderRichInteraction).not.toHaveBeenCalled();
    expect(beta.resetStreaming).toHaveBeenCalledWith('sl:C123');
    expect(beta.setTyping).toHaveBeenCalledWith('sl:C123', true);
    expect(beta.addReaction).toHaveBeenCalledWith('sl:C123', 'm-1', 'eyes');
    expect(beta.renderAgentTodo).toHaveBeenCalledOnce();
    expect(beta.renderRichInteraction).toHaveBeenCalledOnce();
  });

  it('routes IPC user questions through the run route Provider Account', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:alpha',
        undefined,
        'slack_alpha',
      )]: {
        name: 'Alpha',
        folder: 'alpha',
        providerAccountId: 'slack_alpha',
        agentId: 'agent:alpha',
        trigger: '@Alpha',
        added_at: '2026-01-01T00:00:00.000Z',
        conversationKind: 'channel',
      },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:beta',
        undefined,
        'slack_beta',
      )]: {
        name: 'Beta',
        folder: 'beta',
        providerAccountId: 'slack_beta',
        agentId: 'agent:beta',
        trigger: '@Beta',
        added_at: '2026-01-01T00:00:00.000Z',
        conversationKind: 'channel',
      },
    });
    const alphaQuestion = vi.fn(async () => ({
      requestId: 'q-alpha',
      answers: { Choice: 'A' },
    }));
    const betaQuestion = vi.fn(async () => ({
      requestId: 'q-alpha',
      answers: { Choice: 'B' },
    }));
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'agent:alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        runtimeSecretRefs: {},
      },
      slack_beta: {
        agentId: 'agent:beta',
        provider: 'slack',
        label: 'Beta Slack',
        runtimeSecretRefs: {},
      },
    };
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) =>
          makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
            requestUserAnswer:
              opts.providerAccountId === 'slack_alpha'
                ? alphaQuestion
                : betaQuestion,
          }),
        ),
      ],
    });
    await wiring.connectEnabledChannels(settings);

    await expect(
      wiring.requestUserAnswer({
        requestId: 'q-alpha',
        sourceAgentFolder: 'alpha',
        targetJid: 'sl:C123',
        questions: [],
      }),
    ).resolves.toEqual({ requestId: 'q-alpha', answers: { Choice: 'A' } });
    expect(alphaQuestion).toHaveBeenCalledOnce();
    expect(betaQuestion).not.toHaveBeenCalled();
  });

  it('routes permission approvals through explicit Provider Account request context', async () => {
    const app = makeApp({});
    const alphaApproval = vi.fn(
      async (
        _jid: string,
        _request: PermissionApprovalRequest,
        onPromptDelivered?: (messageId: string) => void,
      ) => {
        onPromptDelivered?.('alpha-approval-message');
        return { approved: true };
      },
    );
    const betaApproval = vi.fn(async () => ({ approved: false }));
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'agent:alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        runtimeSecretRefs: {},
      },
      slack_beta: {
        agentId: 'agent:beta',
        provider: 'slack',
        label: 'Beta Slack',
        runtimeSecretRefs: {},
      },
    };
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) =>
          makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
            requestPermissionApproval:
              opts.providerAccountId === 'slack_alpha'
                ? alphaApproval
                : betaApproval,
          }),
        ),
      ],
    });
    await wiring.connectEnabledChannels(settings);

    await expect(
      wiring.requestPermissionApproval({
        requestId: 'req-alpha-explicit',
        sourceAgentFolder: 'alpha',
        providerAccountId: 'slack_alpha',
        targetJid: 'sl:C123',
        toolName: 'danger-tool',
      }),
    ).resolves.toEqual({ approved: true });
    expect(alphaApproval).toHaveBeenCalledOnce();
    expect(betaApproval).not.toHaveBeenCalled();
  });

  it('routes shared-inbound prompts through the callback-capable Provider Account channel', async () => {
    const app = makeApp({});
    const callbackApproval = vi.fn(
      async (
        _jid: string,
        request: PermissionApprovalRequest,
        onPromptDelivered?: (messageId: string) => void,
      ) => {
        onPromptDelivered?.('shared-approval-message');
        return {
          approved: request.providerAccountId === 'slack_beta',
        };
      },
    );
    const callbackQuestion = vi.fn(
      async (_jid: string, request: UserQuestionRequest) => ({
        requestId: request.requestId,
        answers: { Account: request.providerAccountId ?? 'missing' },
      }),
    );
    const outboundOnlyApproval = vi.fn(async () => ({ approved: false }));
    const outboundOnlyQuestion = vi.fn(async () => ({
      requestId: 'unused',
      answers: {},
    }));
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'agent:alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        runtimeSecretRefs: { app_token: 'same-app', bot_token: 'same-bot' },
      },
      slack_beta: {
        agentId: 'agent:beta',
        provider: 'slack',
        label: 'Beta Slack',
        runtimeSecretRefs: { bot_token: 'same-bot', app_token: 'same-app' },
      },
    };
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) =>
          makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
            requestPermissionApproval:
              opts.providerAccountId === 'slack_alpha'
                ? callbackApproval
                : outboundOnlyApproval,
            requestUserAnswer:
              opts.providerAccountId === 'slack_alpha'
                ? callbackQuestion
                : outboundOnlyQuestion,
          }),
        ),
      ],
    });
    await wiring.connectEnabledChannels(settings);

    await expect(
      wiring.requestPermissionApproval({
        requestId: 'req-beta-shared',
        sourceAgentFolder: 'beta',
        providerAccountId: 'slack_beta',
        targetJid: 'sl:C123',
        toolName: 'danger-tool',
      }),
    ).resolves.toEqual({ approved: true });
    await expect(
      wiring.requestUserAnswer({
        requestId: 'q-beta-shared',
        sourceAgentFolder: 'beta',
        providerAccountId: 'slack_beta',
        targetJid: 'sl:C123',
        questions: [],
      }),
    ).resolves.toEqual({
      requestId: 'q-beta-shared',
      answers: { Account: 'slack_beta' },
    });
    expect(callbackApproval).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ providerAccountId: 'slack_beta' }),
      expect.any(Function),
    );
    expect(callbackQuestion).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ providerAccountId: 'slack_beta' }),
      expect.any(Function),
    );
    expect(outboundOnlyApproval).not.toHaveBeenCalled();
    expect(outboundOnlyQuestion).not.toHaveBeenCalled();
  });

  it('does not fan top-level messages into thread-only agent routes', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey('tg:123', 'agent:topic', 'topic-1')]: {
        name: 'Topic',
        folder: 'topic',
        trigger: '@Topic',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    const storeMessage = vi.fn(async () => {});
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      appId: 'app-one' as never,
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: {
        storeMessage,
        storeMessageWithLiveAdmission,
      } as any,
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await onMessage?.('tg:123', {
      id: 'm-top-level',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(storeMessage).not.toHaveBeenCalled();
    expect(storeMessageWithLiveAdmission).not.toHaveBeenCalled();
  });

  it('fans threaded provider messages only to exact thread routes', async () => {
    const app = makeApp({
      [makeAgentThreadQueueKey('tg:123', 'agent:whole')]: {
        name: 'Whole',
        folder: 'whole',
        providerAccountId: 'telegram_default',
        trigger: '@Whole',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
      [makeAgentThreadQueueKey('tg:123', 'agent:topic', 'topic-1')]: {
        name: 'Topic',
        folder: 'topic',
        providerAccountId: 'telegram_default',
        trigger: '@Topic',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
      },
    });
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      appId: 'app-one' as never,
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: {
        storeMessage: vi.fn(),
        storeMessageWithLiveAdmission,
      } as any,
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await onMessage?.('tg:123', {
      id: 'm-threaded',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
      thread_id: 'topic-1',
    });

    expect(storeMessageWithLiveAdmission).toHaveBeenCalledTimes(1);
    expect(storeMessageWithLiveAdmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent:topic',
        triggerDecision: expect.objectContaining({ requiresTrigger: true }),
      }),
    );
  });

  it('deduplicates legacy bare and agent-qualified routes for the same agent', async () => {
    const app = makeApp({
      'tg:123': {
        name: 'Legacy Alpha',
        folder: 'alpha',
        providerAccountId: 'telegram_default',
        trigger: '@Legacy',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
      [makeAgentThreadQueueKey('tg:123', 'agent:alpha')]: {
        name: 'Alpha',
        folder: 'alpha',
        providerAccountId: 'telegram_default',
        trigger: '@Alpha',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
      },
    });
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      appId: 'app-one' as never,
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: {
        storeMessage: vi.fn(),
        storeMessageWithLiveAdmission,
      } as any,
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await onMessage?.('tg:123', {
      id: 'm-live-admission',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(storeMessageWithLiveAdmission).toHaveBeenCalledTimes(1);
    expect(storeMessageWithLiveAdmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent:alpha',
        triggerDecision: expect.objectContaining({ requiresTrigger: true }),
      }),
    );
  });

  it('waits for queue capacity when message persistence queue is full', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main' },
    });
    const storeMessage = vi.fn(async () => {});
    const warn = vi.fn();
    const persistenceQueue = new AsyncTaskQueue(1, 1);
    let releaseFirst!: () => void;
    expect(
      persistenceQueue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      ),
    ).toBe(true);
    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        logger: {
          info: vi.fn(),
          warn,
          debug: vi.fn(),
          error: vi.fn(),
        },
        opsRepository: { storeMessage } as any,
      },
      ops: () => ({ storeMessage, storeChatMetadata: vi.fn() }) as any,
      findBoundChannel: vi.fn(),
      persistenceQueue,
    });

    const msg = {
      id: 'm4',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    const handled = handlers.onMessage('tg:123', msg);

    await Promise.resolve();
    expect(storeMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { chatJid: 'tg:123', queueSize: 1 },
      'Persistence queue full; waiting to enqueue message persistence',
    );

    releaseFirst();
    await handled;
    await persistenceQueue.waitForIdle();

    expect(storeMessage).toHaveBeenCalledWith(msg);
  });

  it('formats outbound messages using provider registry id for the jid', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      name: 'telegram-adapter-name',
      ownsJid: vi.fn((jid: string) => jid === 'tg:123'),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await wiring.sendMessage('tg:123', '**done**', {
      durability: 'best_effort',
    });
    expect(outbound.sendMessage).toHaveBeenCalledWith('tg:123', '*done*');
  });

  it('does not fall back across Provider Accounts for outbound delivery', async () => {
    const app = makeApp();
    const alpha = makeChannel({
      name: 'slack',
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => undefined),
    });
    const beta = makeChannel({
      name: 'slack',
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => undefined),
    });
    const create = vi.fn().mockReturnValueOnce(alpha).mockReturnValueOnce(beta);
    const settings = makeRuntimeSettings({ telegram: false, slack: true });
    settings.providerAccounts = {
      slack_alpha: {
        agentId: 'agent:alpha',
        provider: 'slack',
        label: 'Alpha Slack',
        runtimeSecretRefs: {},
      },
      slack_beta: {
        agentId: 'agent:beta',
        provider: 'slack',
        label: 'Beta Slack',
        runtimeSecretRefs: {},
      },
    };
    const wiring = createChannelWiring(app, {
      providerIds: [makeProvider('slack', create)],
    });
    await wiring.connectEnabledChannels(settings);

    await wiring.sendMessage('sl:C123', 'done', {
      durability: 'best_effort',
      messageOptions: { providerAccountId: 'slack_beta' },
    });
    await wiring.sendMessage('sl:C123', 'ambiguous', {
      durability: 'best_effort',
    });

    expect(alpha.sendMessage).not.toHaveBeenCalled();
    expect(beta.sendMessage).toHaveBeenCalledOnce();
  });

  it('passes the resolved Provider Account into durable outbound attempts', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      name: 'slack',
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => undefined),
    });
    const durableFactory = vi.fn(async () => ({
      settleSent: vi.fn(async () => undefined),
      settleFailed: vi.fn(async () => undefined),
      settlePartiallyDelivered: vi.fn(async () => undefined),
    }));
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
    });
    wiring.setDurableOutboundAttemptFactory(durableFactory);
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await wiring.sendMessage('sl:C123', 'done', {
      durability: 'required',
      messageOptions: { threadId: '171.123' },
    });

    expect(durableFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'sl:C123',
        threadId: '171.123',
        providerAccountId: 'slack_default',
      }),
    );
  });

  it('records outbound final messages as pending and then sent', async () => {
    const app = makeApp();
    const storeMessage = vi.fn(async () => {});
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => ({ externalMessageId: '171.123' })),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      opsRepository: { storeMessage } as any,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await wiring.sendMessage('sl:C123', 'done', {
      durability: 'best_effort',
      messageOptions: {
        threadId: '1700.1',
        providerAccountId: 'slack_default',
      },
    });

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        content: 'done',
        thread_id: '1700.1',
        providerAccountId: 'slack_default',
        delivery_status: 'pending',
        is_bot_message: true,
      }),
    );
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        providerAccountId: 'slack_default',
        external_message_id: '171.123',
        delivery_status: 'sent',
        delivered_at: expect.any(String),
      }),
    );
  });

  it('records outbound messages with the resolved Provider Account when omitted by caller', async () => {
    const storeMessage = vi.fn(async () => {});
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => ({ externalMessageId: '171.123' })),
    });
    const wiring = createChannelWiring(makeApp(), {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      opsRepository: { storeMessage } as any,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await wiring.sendMessage('sl:C123', 'done', {
      durability: 'best_effort',
    });

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        providerAccountId: 'slack_default',
        delivery_status: 'pending',
      }),
    );
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        providerAccountId: 'slack_default',
        delivery_status: 'sent',
      }),
    );
  });

  it('publishes provider-neutral outbound conversation message events', async () => {
    const app = makeApp();
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => ({ externalMessageId: '171.123' })),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      publishRuntimeEvent,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await wiring.sendMessage('sl:C123', 'done', {
      durability: 'best_effort',
      messageOptions: { threadId: '1700.1' },
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        conversationId: 'sl:C123',
        threadId: '1700.1',
        eventType: 'conversation.message.outbound',
        actor: 'agent',
        responseMode: 'none',
        payload: expect.objectContaining({
          conversationId: 'conversation:slack_default:sl:C123',
          threadId: 'thread:slack_default:sl:C123:1700.1',
          direction: 'outbound',
          deliveryStatus: 'sent',
          externalMessageId: '171.123',
          sender: { id: 'gantry', name: 'Gantry' },
          text: 'done',
        }),
      }),
    );
  });

  it('requires a channel-minted recovery permit for provider-level recovery sends', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendProviderMessage('sl:C123', 'Recovered outbound', {
        permit: {
          deliveryId: 'delivery:1',
          itemId: 'delivery-item:1',
          destinationJid: 'sl:C123',
          canonicalText: 'Recovered outbound',
        } as any,
      }),
    ).rejects.toThrow(/recovery dispatch permit/);
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('allows provider-level recovery sends only when permit scope matches destination payload', async () => {
    const app = makeApp();
    const storeMessage = vi.fn(async () => undefined);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => ({ externalMessageId: '171.123' })),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      opsRepository: { storeMessage } as any,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    const permit = wiring.createRecoveryDispatchPermit({
      deliveryId: 'delivery:1',
      itemId: 'delivery-item:1',
      destinationJid: 'sl:C123',
      canonicalText: 'Recovered outbound',
      threadId: '171.000',
    });
    await wiring.sendProviderMessage('sl:C123', 'Recovered outbound', {
      permit,
      messageOptions: { threadId: '171.000' },
      throwOnMissing: true,
    });

    expect(outbound.sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      'Recovered outbound',
      { threadId: '171.000' },
    );
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('fails closed before provider send when durable outbound delivery storage is unavailable', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'durable', { durability: 'required' }),
    ).rejects.toThrow(/Durable outbound delivery is required/);
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('continues provider send when best-effort pending persistence fails', async () => {
    const app = makeApp();
    const storeMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('db offline'))
      .mockResolvedValueOnce(undefined);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      opsRepository: { storeMessage } as any,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'best-effort', {
        durability: 'best_effort',
      }),
    ).resolves.toBeUndefined();
    expect(outbound.sendMessage).toHaveBeenCalledWith('sl:C123', 'best-effort');
  });

  it('preserves provider send errors when failure-state persistence fails', async () => {
    const app = makeApp();
    const providerErr = new Error('provider send failed');
    const persistErr = new Error('persist failed');
    const storeMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(persistErr);
    const error = vi.fn();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => {
        throw providerErr;
      }),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error,
      },
      opsRepository: { storeMessage } as any,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'done', { durability: 'best_effort' }),
    ).rejects.toThrow(providerErr);

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        delivery_status: 'failed',
        delivery_error: 'provider send failed',
      }),
    );
    expect(error).toHaveBeenCalledWith(
      { err: persistErr, jid: 'sl:C123' },
      'Failed to persist outbound delivery failure',
    );
  });

  it('persists retry-tail metadata durably for partial live sends before bubbling the partial error', async () => {
    const app = makeApp();
    const storeMessage = vi.fn().mockResolvedValue(undefined);
    const settlePartiallyDelivered = vi.fn(async () => undefined);
    const partial = new PartialMessageDeliveryError({
      cause: new Error('second chunk failed'),
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialSlackDeliveryError',
      message: 'first chunk visible',
    });
    Object.assign(partial, {
      provider: 'slack',
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'unsent suffix',
        providerPayload: {
          provider: 'slack',
          channelId: 'CWRONG',
          threadId: 'thread-1',
        },
      },
    });
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => {
        throw partial;
      }),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      opsRepository: { storeMessage } as any,
    });
    wiring.setDurableOutboundAttemptFactory(
      vi.fn(async () => ({
        settleSent: vi.fn(async () => undefined),
        settleFailed: vi.fn(async () => undefined),
        settlePartiallyDelivered,
      })),
    );
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'done', {
        durability: 'required',
        messageOptions: { threadId: 'thread-1' },
      }),
    ).rejects.toThrow(partial);

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        delivery_status: 'partially_sent',
        delivery_retry_tail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'slack', threadId: 'thread-1' },
        },
      }),
    );
    expect(settlePartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'slack', threadId: 'thread-1' },
        },
      }),
    );
  });

  it('omits mismatched Telegram chatId retry-tail metadata before durable and message-row partial persistence', async () => {
    const app = makeApp();
    const storeMessage = vi.fn().mockResolvedValue(undefined);
    const settlePartiallyDelivered = vi.fn(async () => undefined);
    const partial = new PartialMessageDeliveryError({
      cause: new Error('second chunk failed'),
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialTelegramDeliveryError',
      message: 'first chunk visible',
    });
    Object.assign(partial, {
      provider: 'telegram',
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'unsent suffix',
        providerPayload: {
          provider: 'telegram',
          chatId: 'tg:-100999',
          threadId: '42',
        },
      },
    });
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-100123'),
      sendMessage: vi.fn(async () => {
        throw partial;
      }),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      opsRepository: { storeMessage } as any,
    });
    wiring.setDurableOutboundAttemptFactory(
      vi.fn(async () => ({
        settleSent: vi.fn(async () => undefined),
        settleFailed: vi.fn(async () => undefined),
        settlePartiallyDelivered,
      })),
    );
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await expect(
      wiring.sendMessage('tg:-100123', 'done', {
        durability: 'required',
        messageOptions: { threadId: '42' },
      }),
    ).rejects.toThrow(partial);

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'tg:-100123',
        delivery_status: 'partially_sent',
        delivery_retry_tail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'telegram', threadId: '42' },
        },
      }),
    );
    expect(settlePartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'telegram', threadId: '42' },
        },
      }),
    );
  });

  it('surfaces ambiguous durable state when durable sent settlement fails after visible send', async () => {
    const app = makeApp();
    const storeMessage = vi.fn().mockResolvedValueOnce(undefined);
    const settleSent = vi
      .fn()
      .mockRejectedValueOnce(new Error('sent status write failed'));
    const settlePartiallyDelivered = vi.fn(async () => undefined);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => ({ externalMessageId: '171.123' })),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      opsRepository: { storeMessage } as any,
    });
    wiring.setDurableOutboundAttemptFactory(
      vi.fn(async () => ({
        settleSent,
        settleFailed: vi.fn(async () => undefined),
        settlePartiallyDelivered,
      })),
    );
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'done', { durability: 'required' }),
    ).rejects.toBeInstanceOf(AmbiguousDurableDeliveryError);

    expect(outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(settleSent).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: '171.123',
      }),
    );
    expect(settlePartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('cannot be blindly retried'),
      }),
    );
    expect(storeMessage).toHaveBeenCalledTimes(1);
  });

  it('raises ambiguous outcome when partial retry-tail durable settlement cannot be persisted', async () => {
    const app = makeApp();
    const storeMessage = vi.fn().mockResolvedValue(undefined);
    const partial = new PartialMessageDeliveryError({
      cause: new Error('second chunk failed'),
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialSlackDeliveryError',
      message: 'first chunk visible',
    });
    Object.assign(partial, {
      provider: 'slack',
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'unsent suffix',
        providerPayload: { provider: 'slack', chunk: 2 },
      },
    });
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => {
        throw partial;
      }),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      opsRepository: { storeMessage } as any,
    });
    wiring.setDurableOutboundAttemptFactory(
      vi.fn(async () => ({
        settleSent: vi.fn(async () => undefined),
        settleFailed: vi.fn(async () => undefined),
        settlePartiallyDelivered: vi.fn(async () => {
          throw new Error('durable enqueue unavailable');
        }),
      })),
    );
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'done', { durability: 'required' }),
    ).rejects.toBeInstanceOf(AmbiguousDurableDeliveryError);
    expect(storeMessage).toHaveBeenCalledTimes(2);
  });

  it('does not fallback to direct provider sends when channel has no streaming sink', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const ok = await wiring.sendStreamingChunk(
      'tg:-123',
      '<internal>scratch</internal>**done**',
    );

    expect(ok).toBe(false);
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves leading and trailing whitespace for streaming chunks', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:D123'),
      sendStreamingChunk: vi.fn(async () => true),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
          {
            isGroupJid: () => false,
          },
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    const ok = await wiring.sendStreamingChunk('sl:D123', ' leading ');

    expect(ok).toBe(true);
    expect(outbound.sendStreamingChunk).toHaveBeenCalledWith(
      'sl:D123',
      ' leading ',
      undefined,
    );
  });

  it('advertises supportsStreaming=true when provider streaming sink exists', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
      sendStreamingChunk: vi.fn(async () => true),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    expect(wiring.supportsStreaming('tg:-123')).toBe(true);
  });

  it('does not advertise Telegram private draft streaming', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:123'),
      sendStreamingChunk: vi.fn(async () => true),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    expect(wiring.supportsStreaming('tg:123')).toBe(false);
    const ok = await wiring.sendStreamingChunk('tg:123', 'final text', {
      done: true,
    });
    expect(ok).toBe(false);
    expect(outbound.sendStreamingChunk).not.toHaveBeenCalled();
  });

  it('calls provider streaming sinks for partial chunks', async () => {
    const app = makeApp();
    const streamSink = vi.fn(async () => true);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
      sendStreamingChunk: streamSink,
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const ok = await wiring.sendStreamingChunk('tg:-123', 'chunk', {
      threadId: 'thread-1',
    });

    expect(ok).toBe(true);
    expect(streamSink).toHaveBeenCalledWith('tg:-123', 'chunk', {
      threadId: 'thread-1',
    });
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('calls provider streaming sinks for final chunks and returns their delivery result', async () => {
    const app = makeApp();
    const streamSink = vi.fn(async () => true);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
      sendStreamingChunk: streamSink,
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const ok = await wiring.sendStreamingChunk('tg:-123', 'chunk', {
      threadId: 'thread-1',
      done: true,
    });

    expect(ok).toBe(true);
    expect(streamSink).toHaveBeenCalledWith('tg:-123', 'chunk', {
      threadId: 'thread-1',
      done: true,
    });
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves done=true streaming callbacks after content stripping', async () => {
    const app = makeApp();
    const streamSink = vi.fn(async () => true);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
      sendStreamingChunk: streamSink,
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const ok = await wiring.sendStreamingChunk(
      'tg:-123',
      '<internal>only-internal</internal>',
      { done: true },
    );

    expect(ok).toBe(true);
    expect(streamSink).toHaveBeenCalledWith('tg:-123', '', { done: true });
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('routes permission approvals through the target conversation only', async () => {
    const app = makeApp({
      'tg:other': { name: 'Other', folder: 'other' },
    });

    const approvalChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:other'),
      requestPermissionApproval: vi.fn(
        async (_jid, _request, onPromptDelivered) => {
          onPromptDelivered?.('target-approval-message');
          return { approved: true };
        },
      ),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => approvalChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );
    const result = await wiring.requestPermissionApproval({
      requestId: 'req-1',
      sourceAgentFolder: 'tg:other',
      targetJid: 'tg:other',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);

    const fallbackWiring = createChannelWiring(makeApp({}));
    const fallback = await fallbackWiring.requestPermissionApproval({
      requestId: 'req-2',
      sourceAgentFolder: 'tg:none',
      toolName: 'danger-tool',
    });

    expect(fallback).toEqual({
      approved: false,
      reason: 'Permission approval target is missing',
    });
  });

  it('keeps prompt surfaces available when inbound callbacks are disabled', async () => {
    const app = makeApp({
      'tg:other': { name: 'Other', folder: 'other' },
    });
    const requestPermissionApproval = vi.fn(
      async (_jid, _request, onPromptDelivered) => {
        onPromptDelivered?.('outbound-approval-message');
        return { approved: true };
      },
    );
    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'q-outbound-only',
      answers: { Choice: 'A' },
    }));
    const outboundOnlyChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:other'),
      requestPermissionApproval,
      requestUserAnswer,
      supportsInteractionCallbacks: vi.fn(() => false),
    } as Partial<ChannelAdapter> & {
      supportsInteractionCallbacks: () => boolean;
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outboundOnlyChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await expect(
      wiring.requestPermissionApproval({
        requestId: 'req-outbound-only',
        sourceAgentFolder: 'tg:other',
        targetJid: 'tg:other',
        toolName: 'danger-tool',
      }),
    ).resolves.toEqual({ approved: true });
    await expect(
      wiring.requestUserAnswer({
        requestId: 'q-outbound-only',
        sourceAgentFolder: 'tg:other',
        targetJid: 'tg:other',
        questions: [],
      }),
    ).resolves.toEqual({
      requestId: 'q-outbound-only',
      answers: { Choice: 'A' },
    });
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(requestUserAnswer).toHaveBeenCalledOnce();
  });

  it('routes direct DM permission approvals to the direct conversation', async () => {
    const app = makeApp({
      'tg:111': { name: 'Alice DM', folder: 'main_agent' },
    });
    const requestPermissionApproval = vi.fn(
      async (_jid, _request, onPromptDelivered) => {
        onPromptDelivered?.('direct-approval-message');
        return { approved: true };
      },
    );

    const approvalChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid.startsWith('tg:')),
      requestPermissionApproval,
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => approvalChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const result = await wiring.requestPermissionApproval({
      requestId: 'req-dm-admin',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:111',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      'tg:111',
      expect.objectContaining({
        targetJid: 'tg:111',
      }),
      expect.any(Function),
    );
  });

  it('treats settings-style dm conversations as direct approval contexts', async () => {
    const app = makeApp({
      'tg:222': { name: 'Bob DM', folder: 'main_agent' },
    });
    const requestPermissionApproval = vi.fn(
      async (_jid, _request, onPromptDelivered) => {
        onPromptDelivered?.('settings-dm-approval-message');
        return { approved: true };
      },
    );

    const approvalChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid.startsWith('tg:')),
      requestPermissionApproval,
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => approvalChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const result = await wiring.requestPermissionApproval({
      requestId: 'req-dm-settings-kind',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:222',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      'tg:222',
      expect.objectContaining({
        targetJid: 'tg:222',
      }),
      expect.any(Function),
    );
  });

  it('authorizes direct DM approval with conversation control approvers', async () => {
    const app = makeApp({
      'app:D123': { name: 'Agent One DM', folder: 'agent_one_dm' },
    });
    let isControlApproverAllowed:
      | ((input: {
          providerId: string;
          conversationJid: string;
          userId: string;
          sourceAgentFolder: string;
        }) => Promise<boolean>)
      | undefined;
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValue(
      {
        id: 'conversation:app:D123',
        appId: 'default',
        providerAccountId: 'app_default',
        kind: 'direct',
        status: 'active',
      },
    );
    runtimeStoreMock.repositories.providerAccounts.getProviderAccount.mockResolvedValue(
      {
        id: 'app_default',
        appId: 'default',
        providerId: 'app',
      },
    );
    runtimeStoreMock.repositories.providerAccounts.getConversationInstall.mockResolvedValue(
      { status: 'active' },
    );
    runtimeStoreMock.repositories.conversations.listConversationApprovers.mockResolvedValue(
      [{ externalUserId: 'UADMIN' }],
    );
    runtimeStoreMock.repositories.conversations.listParticipantExternalUserIds.mockResolvedValue(
      ['UADMIN'],
    );

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) => {
          isControlApproverAllowed = opts.isControlApproverAllowed;
          return makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid.startsWith('app:')),
          });
        }),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      isControlApproverAllowed?.({
        providerId: 'app',
        providerAccountId: 'app_default',
        agentId: 'agent:main_agent',
        conversationJid: 'app:D123',
        userId: 'UADMIN',
        sourceAgentFolder: 'app:D123',
      }),
    ).resolves.toBe(true);
    await expect(
      isControlApproverAllowed?.({
        providerId: 'app',
        providerAccountId: 'app_default',
        agentId: 'agent:main_agent',
        conversationJid: 'app:D123',
        userId: 'U1',
        sourceAgentFolder: 'app:D123',
      }),
    ).resolves.toBe(false);
  });

  it('does not use legacy settings control allowlists for conversation approvals', async () => {
    const app = makeApp({
      'sl:C123': { name: 'Team', folder: 'team' },
    });
    let isControlApproverAllowed:
      | ((input: {
          providerId: string;
          conversationJid: string;
          userId: string;
          sourceAgentFolder: string;
        }) => Promise<boolean>)
      | undefined;
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValue(
      {
        id: 'conversation:sl:C123',
        appId: 'default',
        providerId: 'slack',
        kind: 'channel',
      },
    );
    runtimeStoreMock.repositories.conversations.listConversationApprovers.mockResolvedValue(
      [],
    );
    const legacyControlAllowed = vi.fn(() => true);

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) => {
          isControlApproverAllowed = opts.isControlApproverAllowed;
          return makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid.startsWith('sl:')),
          });
        }),
      ],
      loadSenderControlAllowlist: vi.fn(() => ({}) as any),
      isSenderControlAllowed: legacyControlAllowed,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      isControlApproverAllowed?.({
        providerId: 'slack',
        conversationJid: 'sl:C123',
        userId: 'UADMIN',
        sourceAgentFolder: 'team',
      }),
    ).resolves.toBe(false);
    expect(legacyControlAllowed).not.toHaveBeenCalled();
  });

  it('routes targeted user questions to the originating channel', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main' },
      'tg:group': { name: 'Group', folder: 'group' },
    });

    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'q-1',
      answers: { Choice: 'A' },
      answeredBy: '5759865942',
    }));
    const questionChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:group'),
      requestUserAnswer,
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => questionChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const response = await wiring.requestUserAnswer({
      requestId: 'q-1',
      sourceAgentFolder: 'group',
      targetJid: 'tg:group',
      questions: [],
    });

    expect(response).toEqual({
      requestId: 'q-1',
      answers: { Choice: 'A' },
      answeredBy: '5759865942',
    });
    expect(requestUserAnswer).toHaveBeenCalledWith(
      'tg:group',
      expect.objectContaining({
        requestId: 'q-1',
        sourceAgentFolder: 'group',
        targetJid: 'tg:group',
      }),
      expect.any(Function),
    );
    expect(questionChannel.sendMessage).not.toHaveBeenCalled();
  });

  it('uses provider progress sink when available', async () => {
    const app = makeApp({
      'tg:group': { name: 'Group', folder: 'group' },
    });
    const sendProgressUpdate = vi.fn(async () => undefined);
    const channel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:group'),
      sendProgressUpdate,
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    expect(wiring.supportsProgress('tg:group')).toBe(true);
    await wiring.sendProgressUpdate('tg:group', 'Working on it...', {
      threadId: 'thread-1',
    });

    expect(sendProgressUpdate).toHaveBeenCalledWith(
      'tg:group',
      'Working on it...',
      { threadId: 'thread-1' },
    );
  });

  it('reports agent todo render failure when the channel surface returns false', async () => {
    const renderAgentTodo = vi.fn(async () => false);
    const render = createAgentTodoRenderer({
      findBoundChannel: () => makeChannel({ renderAgentTodo }),
      asAgentTodoSurface: (channel) => channel,
      logger: { error: vi.fn() },
    });

    await expect(
      render('tg:group', {
        items: [{ id: '1', title: 'Work', status: 'pending' }],
      }),
    ).resolves.toBe(false);
  });

  it('flushes host terminal todo status over the latest model-rendered card', async () => {
    const renderAgentTodo = vi.fn(async () => true);
    const render = createAgentTodoRenderer({
      findBoundChannel: () => makeChannel({ renderAgentTodo }),
      asAgentTodoSurface: (channel) => channel,
      logger: { error: vi.fn() },
    });

    await render('tg:group', {
      summary: 'Plan done',
      status: 'done',
      threadId: 'thread-1',
      stop: { label: 'Stop', actionToken: 'stale-stop-token' },
      items: [{ id: '1', title: 'Work', status: 'completed' }],
    });

    await expect(
      render.finalize('tg:group', {
        threadId: 'thread-1',
        status: 'failed',
      }),
    ).resolves.toBe(true);

    expect(renderAgentTodo).toHaveBeenLastCalledWith(
      'tg:group',
      expect.objectContaining({
        summary: 'Plan done',
        status: 'failed',
        stop: undefined,
        flush: true,
        items: [{ id: '1', title: 'Work', status: 'completed' }],
      }),
    );
  });

  it('does not emit user-question receipts through progress or direct sends', async () => {
    const app = makeApp({
      'tg:group': { name: 'Group', folder: 'group' },
    });

    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'q-dup',
      answers: { Choice: 'A' },
      answeredBy: 'u-1',
    }));
    const questionChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:group'),
      requestUserAnswer,
      sendProgressUpdate: vi.fn(async () => undefined),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => questionChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const first = await wiring.requestUserAnswer({
      requestId: 'q-dup',
      sourceAgentFolder: 'group',
      targetJid: 'tg:group',
      threadId: 'thread-1',
      questions: [],
    });
    const second = await wiring.requestUserAnswer({
      requestId: 'q-dup',
      sourceAgentFolder: 'group',
      targetJid: 'tg:group',
      threadId: 'thread-1',
      questions: [],
    });

    expect(first).toEqual(second);
    expect(requestUserAnswer).toHaveBeenCalledTimes(1);
    expect(questionChannel.sendProgressUpdate).not.toHaveBeenCalled();
    expect(questionChannel.sendMessage).not.toHaveBeenCalled();
  });

  it('returns empty answers when user-question flow fails', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main' },
    });

    const questionChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:main'),
      requestUserAnswer: vi.fn(async () => {
        throw new Error('request failed');
      }),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => questionChannel),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const response = await wiring.requestUserAnswer({
      requestId: 'q-1',
      sourceAgentFolder: 'tg:main',
      questions: [],
    });

    expect(response).toEqual({ requestId: 'q-1', answers: {} });
  });
});

describe('createChannelPersistenceHandlers conversation-owned direct routes', () => {
  function makePersistenceHandlers(
    app: RuntimeApp,
    storeMessage = vi.fn(async () => undefined),
  ) {
    return {
      storeMessage,
      handlers: createChannelPersistenceHandlers({
        app,
        resolved: {
          providerIds: [],
          loadSenderAllowlist: vi.fn(() => ({}) as any),
          loadSenderControlAllowlist: vi.fn(() => ({}) as any),
          shouldDropMessage: vi.fn(() => false),
          isSenderAllowed: vi.fn(() => true),
          isSenderControlAllowed: vi.fn(() => true),
          shouldLogDenied: vi.fn(() => false),
          logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
          },
          opsRepository: { storeMessage } as any,
        },
        ops: () => ({ storeMessage, storeChatMetadata: vi.fn() }) as any,
        findBoundChannel: vi.fn(),
        persistenceQueue: new AsyncTaskQueue(4, 5_000),
      }),
    };
  }

  it('drops unregistered direct conversations instead of auto-binding by direct conversation policy', async () => {
    const app = makeApp({});
    const { handlers, storeMessage } = makePersistenceHandlers(app);

    await handlers.onChatMetadata(
      'sl:D123',
      '2026-05-01T00:00:00.000Z',
      'User',
      'slack',
      false,
    );
    await handlers.onMessage('sl:D123', {
      id: 'm1',
      chat_jid: 'sl:D123',
      provider: 'slack',
      sender: 'U123',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-05-01T00:00:01.000Z',
    });

    expect(app.registerGroup).not.toHaveBeenCalled();
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('passes provider account context through chat metadata persistence', async () => {
    const storeChatMetadata = vi.fn(async () => undefined);
    const handlers = createChannelPersistenceHandlers({
      app: makeApp({}),
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
        opsRepository: { storeMessage: vi.fn() } as any,
      },
      ops: () => ({ storeMessage: vi.fn(), storeChatMetadata }) as any,
      findBoundChannel: vi.fn(),
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
    });

    await handlers.onChatMetadata(
      'sl:C123',
      '2026-05-01T00:00:00.000Z',
      'sales',
      'slack',
      true,
      { providerAccountId: 'slack_alpha' },
    );

    expect(storeChatMetadata).toHaveBeenCalledWith(
      'sl:C123',
      '2026-05-01T00:00:00.000Z',
      'sales',
      'slack',
      true,
      { providerAccountId: 'slack_alpha' },
    );
  });

  it('persists configured direct conversations through the normal route policy', async () => {
    const app = makeApp({
      'sl:D123': {
        name: 'Agent One DM',
        folder: 'agent_one',
        trigger: '@Agent One',
        added_at: '2026-05-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    });
    const { handlers, storeMessage } = makePersistenceHandlers(app);
    const msg = {
      id: 'm-configured',
      chat_jid: 'sl:D123',
      provider: 'slack',
      sender: 'U123',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-05-01T00:00:01.000Z',
    };

    await handlers.onMessage('sl:D123', msg);

    expect(storeMessage).toHaveBeenCalledWith(msg);
  });
});
