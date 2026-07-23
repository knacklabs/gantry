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
  withLogContext: (_context: unknown, callback: () => unknown) => callback(),
  updateLogContext: vi.fn(),
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
    commandHandlers = new Map<string, (args: any) => Promise<void>>();
    shortcutHandlers = new Map<string, (args: any) => Promise<void>>();
    actionHandlers = new Map<string | RegExp, (args: any) => Promise<void>>();
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
        history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
        replies: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
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
        delete: vi.fn().mockResolvedValue({ ok: true }),
        postEphemeral: vi
          .fn()
          .mockResolvedValue({ ok: true, message_ts: '1710000000.100201' }),
      },
      files: {
        getUploadURLExternal: vi.fn().mockResolvedValue({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/test',
          file_id: 'F123',
        }),
        completeUploadExternal: vi.fn().mockResolvedValue({
          ok: true,
          files: [{ id: 'F123', title: 'report.txt' }],
        }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
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

    command(name: string, handler: (args: any) => Promise<void>) {
      this.commandHandlers.set(name, handler);
    }

    shortcut(name: string, handler: (args: any) => Promise<void>) {
      this.shortcutHandlers.set(name, handler);
    }

    action(name: string | RegExp, handler: (args: any) => Promise<void>) {
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

import {
  createSlackChannel,
  SlackChannel,
} from '@core/channels/slack/channel-adapter.js';
import {
  bindPendingPermissionInteractionMessage,
  configurePendingInteractionDurability,
} from '@core/application/interactions/pending-interaction-durability.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import { slackRateLimitRetryDelayMs } from '@core/channels/slack/channel-retry-delay.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { createPermissionBatchRequest } from '@core/channels/permission-batch-coalescer.js';
import {
  buildPermissionPromptContentBlocks,
  buildPermissionReceiptBlocks,
} from '@core/channels/slack/permission-blocks.js';
import { SLACK_PERMISSION_DECISION_ACTION_IDS } from '@core/channels/slack/permission-action-id.js';
import { writeSlackAttachmentResponse } from '@core/channels/slack/attachment-download.js';
import { asTypingSink } from '@core/app/bootstrap/channel-capability-ports.js';
import type {
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
  PermissionCallbackScope,
} from '@core/domain/types.js';

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
    providerAccountId: 'slack_default',
    conversationRoutes: vi.fn(() => ({})),
    runtimeSettings: vi.fn(() => ({
      providers: {
        slack: { enabled: true },
      },
      providerAccounts: {
        slack_default: {
          agentId: 'default',
          provider: 'slack',
          label: 'Slack',
          runtimeSecretRefs: {
            bot_token: 'env:SLACK_BOT_TOKEN',
            app_token: 'env:SLACK_APP_TOKEN',
          },
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
        slack_long_test_conversation: {
          providerConnection: 'slack_default',
          externalId: 'C1234567890',
          kind: 'channel',
          displayName: 'test-long',
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
    runtimeSecrets: {
      getSecret(ref: { ref?: string; env?: string }) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error('missing secret');
        return value;
      },
      getOptionalSecret(ref: { ref?: string; env?: string }) {
        const name = String(ref.ref ?? ref.env ?? '').replace(/^env:/, '');
        return process.env[name]?.trim();
      },
    },
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
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
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

function configureSlackPermissionRequest(request: PermissionApprovalRequest) {
  const appId = request.appId || 'default';
  const requestIds = request.permissionBatch?.requestIds || [request.requestId];
  const interactions = requestIds.map((requestId) => ({
    id: `pending-${request.sourceAgentFolder}-${requestId}`,
    appId,
    runId: 'run-1',
    sourceAgentFolder: request.sourceAgentFolder,
    requestId,
    runLeaseToken: null,
    runLeaseFencingVersion: null,
    envelopeId: null as string | null,
    memberIndex: null as number | null,
    kind: 'permission' as const,
    status: 'pending' as const,
    payload: {
      requestId,
      sourceAgentFolder: request.sourceAgentFolder,
      request: { ...request, requestId },
      targetJid: request.targetJid,
      decisionPolicy: request.decisionPolicy,
    } as Record<string, unknown>,
    callbackRoute: null,
    idempotencyKey: `${appId}:permission:${request.sourceAgentFolder}:${requestId}`,
    approverRef: null,
    resolution: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2099-07-17T00:00:00.000Z',
    resolvedAt: null,
  }));
  const prompts: Array<{
    prompt: {
      id: string;
      parentEnvelopeId: string | null;
      appId: string;
      sourceAgentFolder: string;
      interactionId: string;
      matchKind: 'individual' | 'batch';
      memberCount: number;
      envelope: any;
      fullView: Record<string, unknown> | null;
      externalPromptProvider: string | null;
      externalPromptConversationId: string | null;
      externalPromptMessageId: string | null;
      externalPromptThreadId: string | null;
      providerAliases: string[];
      claim: PermissionCallbackClaim | null;
      settlementState:
        'open' | 'claimed' | 'settled' | 'review_each_expired' | 'superseded';
      settledAt: string | null;
      createdAt: string;
      updatedAt: string;
    };
    members: typeof interactions;
  }> = [];
  const groupForScope = (
    scope: PermissionCallbackScope,
    includeTerminalSettlement = false,
  ) =>
    [...prompts]
      .reverse()
      .find(
        ({ prompt }) =>
          prompt.appId === scope.appId &&
          prompt.sourceAgentFolder === scope.sourceAgentFolder &&
          prompt.interactionId === scope.interactionId &&
          (includeTerminalSettlement ||
            prompt.settlementState === 'open' ||
            prompt.settlementState === 'claimed'),
      ) ?? null;
  const repository = {
    findPendingInteractionByIdempotencyKey: vi.fn(
      async ({ idempotencyKey }: { idempotencyKey: string }) =>
        interactions.find(
          (interaction) => interaction.idempotencyKey === idempotencyKey,
        ) ?? null,
    ),
    findPendingInteractionByRequest: vi.fn(
      async (input: {
        appId: string;
        kind: 'permission' | 'question';
        sourceAgentFolder?: string;
        requestId: string;
      }) =>
        interactions.find(
          (interaction) =>
            interaction.appId === input.appId &&
            interaction.kind === input.kind &&
            interaction.requestId === input.requestId &&
            (!input.sourceAgentFolder ||
              interaction.sourceAgentFolder === input.sourceAgentFolder),
        ) ?? null,
    ),
    bindPendingPermissionPrompt: vi.fn(async (input: any) => {
      const members = input.members.map(
        (member: {
          idempotencyKey: string;
          requestId: string;
          index: number;
        }) =>
          interactions.find(
            (interaction) =>
              interaction.appId === input.appId &&
              interaction.sourceAgentFolder === input.sourceAgentFolder &&
              interaction.requestId === member.requestId &&
              interaction.idempotencyKey === member.idempotencyKey &&
              interaction.status === 'pending',
          ),
      );
      if (
        members.some(
          (member: (typeof interactions)[number] | undefined) => !member,
        )
      ) {
        return null;
      }
      for (const existing of prompts) {
        if (
          existing.prompt.appId === input.appId &&
          existing.prompt.sourceAgentFolder === input.sourceAgentFolder &&
          existing.prompt.interactionId === input.interactionId &&
          (existing.prompt.settlementState === 'open' ||
            existing.prompt.settlementState === 'claimed')
        ) {
          existing.prompt.settlementState = 'superseded';
        }
      }
      const group = {
        prompt: {
          id: input.id,
          parentEnvelopeId: null,
          appId: input.appId,
          sourceAgentFolder: input.sourceAgentFolder,
          interactionId: input.interactionId,
          matchKind: input.matchKind,
          memberCount: members.length,
          envelope: input.envelope,
          fullView: input.fullView ?? null,
          externalPromptProvider: input.externalPromptProvider ?? null,
          externalPromptConversationId:
            input.externalPromptConversationId ?? null,
          externalPromptMessageId: input.externalPromptMessageId ?? null,
          externalPromptThreadId: input.externalPromptThreadId ?? null,
          providerAliases: [...input.providerAliases],
          claim: null,
          settlementState: 'open' as const,
          settledAt: null,
          createdAt: input.now ?? '2026-07-16T00:00:00.000Z',
          updatedAt: input.now ?? '2026-07-16T00:00:00.000Z',
        },
        members: members as typeof interactions,
      };
      for (const member of input.members) {
        const interaction = interactions.find(
          (candidate) => candidate.idempotencyKey === member.idempotencyKey,
        )!;
        interaction.envelopeId = input.id;
        interaction.memberIndex = member.index;
      }
      prompts.push(group);
      return group;
    }),
    findPendingPermissionPrompt: vi.fn(
      async ({
        scope,
        includeTerminalSettlement,
      }: {
        scope: PermissionCallbackScope;
        includeTerminalSettlement?: boolean;
      }) => groupForScope(scope, includeTerminalSettlement),
    ),
    findPendingPermissionPromptByMember: vi.fn(
      async (input: {
        appId: string;
        sourceAgentFolder: string;
        requestId: string;
      }) =>
        [...prompts]
          .reverse()
          .find(
            (group) =>
              group.prompt.appId === input.appId &&
              group.prompt.sourceAgentFolder === input.sourceAgentFolder &&
              group.members.some(
                (member) => member.requestId === input.requestId,
              ),
          ) ?? null,
    ),
    findPendingPermissionPromptByMessage: vi.fn(
      async (input: {
        appId: string;
        provider: string;
        conversationId: string;
        externalMessageId: string;
        threadId?: string | null;
      }) =>
        prompts.find(
          ({ prompt }) =>
            prompt.appId === input.appId &&
            prompt.externalPromptProvider === input.provider &&
            prompt.externalPromptConversationId === input.conversationId &&
            prompt.externalPromptMessageId === input.externalMessageId &&
            prompt.externalPromptThreadId === (input.threadId ?? null),
        ) ?? null,
    ),
    claimPendingPermissionCallback: vi.fn(
      async ({ claim }: { claim: PermissionCallbackClaim }) => {
        const group = groupForScope(claim.scope);
        if (
          !group ||
          group.prompt.claim ||
          group.prompt.matchKind !== claim.match.kind ||
          (claim.match.providerAliases[0] &&
            !group.prompt.providerAliases.includes(
              claim.match.providerAliases[0],
            ))
        ) {
          return null;
        }
        group.prompt.claim = claim;
        group.prompt.settlementState = 'claimed';
        group.prompt.updatedAt = claim.intent.decidedAt;
        return group;
      },
    ),
    releasePendingPermissionCallback: vi.fn(
      async ({ claim }: { claim: PermissionCallbackClaimReference }) => {
        const group = groupForScope(claim.scope, true);
        if (group?.prompt.claim?.id !== claim.id) return false;
        group.prompt.claim = null;
        group.prompt.settlementState = 'open';
        return true;
      },
    ),
    settlePendingPermissionCallback: vi.fn(
      async ({ claim }: { claim: PermissionCallbackClaimReference }) => {
        const group = groupForScope(claim.scope, true);
        if (group?.prompt.claim?.id !== claim.id) return false;
        group.prompt.settlementState = 'settled';
        group.prompt.settledAt = new Date().toISOString();
        return true;
      },
    ),
    expirePendingPermissionReviewEach: vi.fn(
      async ({
        claim,
        now,
      }: {
        claim: PermissionCallbackClaimReference;
        now: string;
      }) => {
        const group = groupForScope(claim.scope, true);
        const stored = group?.prompt.claim;
        if (
          !group ||
          stored?.id !== claim.id ||
          stored.match.kind !== 'batch' ||
          stored.intent.mode !== 'allow_persistent_rule'
        ) {
          return null;
        }
        group.prompt.settlementState = 'review_each_expired';
        group.prompt.settledAt = now;
        group.prompt.updatedAt = now;
        return group;
      },
    ),
    resolvePendingInteraction: vi.fn(async (input: any) => {
      const interaction = interactions.find(
        (candidate) => candidate.idempotencyKey === input.idempotencyKey,
      );
      if (!interaction) return false;
      if (interaction.status !== 'pending') return true;
      interaction.status = input.status;
      interaction.approverRef = input.approverRef ?? null;
      interaction.resolution = input.resolution;
      interaction.resolvedAt = input.now ?? new Date().toISOString();
      return true;
    }),
  };
  configurePendingInteractionDurability({ repository: repository as never });
  return repository;
}

function requestSlackPermissionApproval(
  channel: SlackChannel,
  jid: string,
  request: PermissionApprovalRequest,
  onPromptDelivered?: (messageId: string) => void,
) {
  configureSlackPermissionRequest(request);
  return channel.requestPermissionApproval(jid, request, onPromptDelivered);
}

function requestSlackUserAnswer(
  channel: SlackChannel,
  jid: string,
  request: import('@core/domain/types.js').UserQuestionRequest,
) {
  const appId = request.appId || 'default';
  const interaction = {
    appId,
    kind: 'question' as const,
    status: 'pending' as const,
    payload: {
      requestId: request.requestId,
      sourceAgentFolder: request.sourceAgentFolder,
      targetJid: request.targetJid || jid,
      request,
      questionRecoveryEnvelope: {
        version: 1,
        targetJid: request.targetJid || jid,
        threadId: request.threadId ?? null,
        request,
        selections: [],
        completedQuestionIndexes: [],
      },
    } as Record<string, unknown>,
    idempotencyKey: `${appId}:question:${request.sourceAgentFolder}:${request.requestId}`,
  };
  const repository = {
    listPendingInteractions: vi.fn(async () => [interaction]),
    findPendingInteractionByRequest: vi.fn(async () => interaction),
    findPendingInteractionByIdempotencyKey: vi.fn(async () => interaction),
    updatePendingInteractionPayload: vi.fn((input) =>
      updatePendingInteractionPayload([interaction], input),
    ),
    resolvePendingInteraction: vi.fn(async () => true),
  };
  configurePendingInteractionDurability({ repository: repository as never });
  const response = channel.requestUserAnswer(jid, request);
  return Object.assign(response, { interaction, repository });
}

function latestSlackPermissionActionValue(actionId: string) {
  const blocks = vi
    .mocked(appRef.current.client.chat.postEphemeral)
    .mock.calls.at(-1)?.[0]?.blocks as Array<{
    type?: string;
    elements?: Array<{ action_id?: string; value?: string }>;
  }>;
  const value = blocks
    ?.flatMap((block) => block.elements || [])
    .find((element) => element.action_id === actionId)?.value;
  if (!value) throw new Error(`Missing Slack action ${actionId}`);
  return JSON.parse(value) as Record<string, unknown>;
}

function latestSlackUserQuestionActionValue(
  actionId: string,
  optionIndex?: number,
) {
  const blocks = vi
    .mocked(appRef.current.client.chat.postMessage)
    .mock.calls.at(-1)?.[0]?.blocks as Array<{
    elements?: Array<{ action_id?: string; value?: string }>;
  }>;
  const values = blocks
    ?.flatMap((block) => block.elements || [])
    .filter(
      (element) =>
        element.value &&
        (element.action_id === actionId ||
          (optionIndex !== undefined &&
            element.action_id === `${actionId}_${optionIndex}`)),
    )
    .map((element) => JSON.parse(element.value!) as Record<string, unknown>);
  const value =
    optionIndex === undefined
      ? values?.[0]
      : values?.find((candidate) => candidate.optionIndex === optionIndex);
  if (!value) throw new Error(`Missing Slack user-question action ${actionId}`);
  return value;
}

function slackActionHandler(
  actionId: string,
): ((args: any) => Promise<void>) | undefined {
  for (const [registeredActionId, handler] of appRef.current.actionHandlers) {
    if (
      registeredActionId === actionId ||
      (registeredActionId instanceof RegExp &&
        registeredActionId.test(actionId))
    ) {
      return handler;
    }
  }
  return undefined;
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
    configurePendingInteractionDurability(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('createSlackChannel returns null when tokens are missing', async () => {
    const savedBot = process.env.SLACK_BOT_TOKEN;
    const savedApp = process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    try {
      await expect(createSlackChannel(createOpts() as any)).resolves.toBeNull();
    } finally {
      if (savedBot !== undefined) process.env.SLACK_BOT_TOKEN = savedBot;
      if (savedApp !== undefined) process.env.SLACK_APP_TOKEN = savedApp;
    }
  });

  it('createSlackChannel returns a channel when Provider Account refs point at env tokens', async () => {
    const savedBot = process.env.SLACK_BOT_TOKEN;
    const savedApp = process.env.SLACK_APP_TOKEN;
    process.env.SLACK_BOT_TOKEN = 'xoxb-file-token';
    process.env.SLACK_APP_TOKEN = 'xapp-file-token';
    try {
      const channel = await createSlackChannel(createOpts() as any);
      expect(channel).toBeInstanceOf(SlackChannel);
    } finally {
      if (savedBot !== undefined) process.env.SLACK_BOT_TOKEN = savedBot;
      else delete process.env.SLACK_BOT_TOKEN;
      if (savedApp !== undefined) process.env.SLACK_APP_TOKEN = savedApp;
      else delete process.env.SLACK_APP_TOKEN;
    }
  });

  it('does not expose Slack as typing-capable', () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );

    expect(asTypingSink(channel)).toBeUndefined();
  });

  it('adds Slack reactions idempotently', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect({ inbound: false });

    await channel.addReaction('sl:C1234567890', '1710000000.000100', 'seen');
    await channel.addReaction('sl:C1234567890', '1710000000.000100', 'seen');

    expect(appRef.current.client.reactions.add).toHaveBeenCalledTimes(1);
    expect(appRef.current.client.reactions.add).toHaveBeenCalledWith({
      channel: 'C1234567890',
      timestamp: '1710000000.000100',
      name: 'eyes',
    });
  });

  it('records metadata only for unregistered Slack conversations', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    expect(handlers.length).toBeGreaterThan(0);
    await handlers[0]({
      event: {
        channel: 'C1234567890',
        ts: '1710000000.000100',
        user: 'U123',
        text: 'hello',
      },
    });

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'sl:C1234567890',
      expect.any(String),
      'ops',
      'slack',
      true,
      { providerAccountId: 'slack_default' },
    );
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('rate-limits unregistered Slack conversation drop logs per chat', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    const handler = appRef.current.eventHandlers.get('message')?.[0];
    expect(handler).toBeDefined();
    const event = {
      channel: 'C987654321',
      ts: '1710000000.000100',
      user: 'U123',
      text: 'hello',
    };

    await handler!({ event });
    await handler!({ event });

    const dropLogs = () =>
      vi
        .mocked(logger.info)
        .mock.calls.filter(
          ([, message]) =>
            message === 'Message from unregistered Slack conversation',
        );
    expect(dropLogs()).toHaveLength(1);
    expect(dropLogs()[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: 'slack',
        chatId: 'C987654321',
      }),
    );

    now += 60_000;
    await handler!({ event });

    expect(dropLogs()).toHaveLength(2);
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
      { providerAccountId: 'slack_default' },
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
      [makeAgentThreadQueueKey('sl:C123', null, null, 'slack_default')]: {
        folder: 'slack_ops',
        name: 'Ops',
      },
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

  it('delivers Slack messages for agent-qualified conversations', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
          trigger: '@Ops',
        },
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
        chat_jid: 'sl:C123',
        content: '@Ops list projects',
        thread_id: '1710000000.000100',
      }),
    );
  });

  it('matches Slack message routes only for the connected provider account', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
          trigger: '@Ops',
        },
      [makeAgentThreadQueueKey('sl:C123', 'agent:sales', null, 'slack_other')]:
        {
          folder: 'slack_sales',
          name: 'Sales',
          trigger: '@Sales',
        },
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
      expect.objectContaining({ content: '@Ops list projects' }),
    );
  });

  it('treats duplicate Slack route aliases for one agent as one route', async () => {
    const opts = createOpts();
    const route = {
      folder: 'slack_ops',
      name: 'Ops',
      trigger: '@Ops',
      providerAccountId: 'slack_default',
    };
    opts.conversationRoutes.mockReturnValue({
      'sl:C123': route,
      [makeAgentThreadQueueKey('sl:C123', 'agent:slack_ops')]: route,
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:slack_ops',
        null,
        'slack_default',
      )]: route,
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
        content: '@Ops list projects',
        providerAccountId: 'slack_default',
        thread_id: '1710000000.000100',
      }),
    );
  });

  it('matches shared Slack inbound routes under the target provider account', async () => {
    const opts = {
      ...createOpts(),
      providerAccountId: 'slack_alpha',
      inboundProviderAccountIds: ['slack_alpha', 'slack_beta'],
    };
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:sales', null, 'slack_beta')]: {
        folder: 'slack_sales',
        name: 'Sales',
        trigger: '@Sales',
        providerAccountId: 'slack_beta',
      },
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
        content: '@Sales list projects',
        providerAccountId: 'slack_beta',
      }),
    );
  });

  it('downloads shared Slack inbound attachments for a single non-primary route', async () => {
    const opts = {
      ...createOpts(),
      providerAccountId: 'slack_alpha',
      inboundProviderAccountIds: ['slack_alpha', 'slack_beta'],
    };
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:sales', null, 'slack_beta')]: {
        folder: 'slack_sales',
        name: 'Sales',
        trigger: '@Sales',
        providerAccountId: 'slack_beta',
      },
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
        providerAccountId: 'slack_beta',
        attachments: [
          expect.objectContaining({
            externalId: 'F123',
            storageRef: 'attachments/report.pdf',
          }),
        ],
      }),
    );
    expect(mkdirSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_sales/attachments',
      { recursive: true, mode: 0o700 },
    );
    expect(writeSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_sales/attachments/report.pdf',
      expect.any(Buffer),
      { mode: 0o600 },
    );
  });

  it('leaves ambiguous shared Slack inbound messages unscoped for account fanout', async () => {
    const opts = {
      ...createOpts(),
      providerAccountId: 'slack_alpha',
      inboundProviderAccountIds: ['slack_alpha', 'slack_beta'],
    };
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_alpha')]: {
        folder: 'slack_ops',
        name: 'Ops',
        trigger: '@Ops',
        providerAccountId: 'slack_alpha',
      },
      [makeAgentThreadQueueKey('sl:C123', 'agent:sales', null, 'slack_beta')]: {
        folder: 'slack_sales',
        name: 'Sales',
        trigger: '@Sales',
        providerAccountId: 'slack_beta',
      },
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
      expect.not.objectContaining({ providerAccountId: expect.any(String) }),
    );
  });

  it('does not treat a Slack thread route as a whole channel route', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        '1710000000.000111',
        'slack_default',
      )]: {
        folder: 'slack_thread',
        name: 'Ops Thread',
        trigger: '@Ops',
      },
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

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('delivers Slack thread messages for exact agent-qualified thread routes', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        '1710000000.000111',
        'slack_default',
      )]: {
        folder: 'slack_thread',
        name: 'Ops Thread',
        trigger: '@Ops',
      },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000222',
        thread_ts: '1710000000.000111',
        user: 'U123',
        text: 'thread reply',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        chat_jid: 'sl:C123',
        content: 'thread reply',
        thread_id: '1710000000.000111',
      }),
    );
  });

  it('delivers Slack messages for multi-agent conversations', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
          providerAccountId: 'slack_default',
        },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:sales',
        null,
        'slack_default',
      )]: {
        folder: 'slack_sales',
        name: 'Sales',
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
        text: 'hello',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        chat_jid: 'sl:C123',
        content: 'hello',
        thread_id: undefined,
      }),
    );
  });

  it('starts a Slack thread for top-level multi-agent messages with one trigger', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
          providerAccountId: 'slack_default',
        },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:sales',
        null,
        'slack_default',
      )]: {
        folder: 'slack_sales',
        name: 'Sales',
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
        text: '@Ops status',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        chat_jid: 'sl:C123',
        content: '@Ops status',
        thread_id: '1710000000.000100',
      }),
    );
  });

  it('keeps ambiguous multi-agent trigger messages root-scoped', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
        },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:triage',
        null,
        'slack_default',
      )]: {
        folder: 'slack_triage',
        name: 'Triage',
        trigger: '@Ops',
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
        text: '@Ops status',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        chat_jid: 'sl:C123',
        content: '@Ops status',
        thread_id: undefined,
      }),
    );
  });

  it('strips the Slack bot mention before multi-agent trigger matching', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
        },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:sales',
        null,
        'slack_default',
      )]: {
        folder: 'slack_sales',
        name: 'Sales',
      },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('app_mention') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000100',
        user: 'U123',
        text: '<@U_BOT> @Ops status',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        chat_jid: 'sl:C123',
        content: '@Ops status',
        thread_id: '1710000000.000100',
      }),
    );
  });

  it('delivers /gantry slash commands through the normal command parser path', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', null, null, 'slack_default')]: {
        folder: 'slack_ops',
        name: 'Ops',
      },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handler = appRef.current.commandHandlers.get('/gantry');
    expect(handler).toBeDefined();
    const ack = vi.fn();
    await handler({
      ack,
      command: {
        channel_id: 'C123',
        user_id: 'U123',
        user_name: 'alice',
        text: 'status',
        trigger_id: 'trigger-1',
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        content: '/gantry status',
        external_message_id: 'trigger-1',
      }),
    );
  });

  it('delivers /gantry slash commands for a single agent-qualified route', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
        },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handler = appRef.current.commandHandlers.get('/gantry');
    await handler!({
      ack: vi.fn(),
      command: {
        channel_id: 'C123',
        user_id: 'U123',
        user_name: 'alice',
        text: 'status',
        trigger_id: 'trigger-1',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ content: '/gantry status' }),
    );
  });

  it('matches Slack slash command routes only for the connected provider account', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
        },
      [makeAgentThreadQueueKey('sl:C123', 'agent:sales', null, 'slack_other')]:
        {
          folder: 'slack_sales',
          name: 'Sales',
        },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handler = appRef.current.commandHandlers.get('/gantry');
    await handler!({
      ack: vi.fn(),
      command: {
        channel_id: 'C123',
        user_id: 'U123',
        user_name: 'alice',
        text: 'status',
        trigger_id: 'trigger-1',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ content: '/gantry status' }),
    );
  });

  it('ignores ambiguous Slack slash commands without an agent selector', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
        },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:sales',
        null,
        'slack_default',
      )]: {
        folder: 'slack_sales',
        name: 'Sales',
      },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handler = appRef.current.commandHandlers.get('/gantry');
    await handler!({
      ack: vi.fn(),
      command: {
        channel_id: 'C123',
        user_id: 'U123',
        user_name: 'alice',
        text: 'status',
        trigger_id: 'trigger-1',
      },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('delivers /gantry slash commands with an agent selector in multi-agent conversations', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
        },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:sales',
        null,
        'slack_default',
      )]: {
        folder: 'slack_sales',
        name: 'Sales',
      },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handler = appRef.current.commandHandlers.get('/gantry');
    await handler!({
      ack: vi.fn(),
      command: {
        channel_id: 'C123',
        user_id: 'U123',
        user_name: 'alice',
        text: '@Ops status',
        trigger_id: 'trigger-1',
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ content: '@Ops /gantry status' }),
    );
  });

  it('does not route slash commands through thread-scoped routes', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        '1710000000.000111',
        'slack_default',
      )]: {
        folder: 'slack_thread',
        name: 'Ops Thread',
      },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handler = appRef.current.commandHandlers.get('/gantry');
    await handler!({
      ack: vi.fn(),
      command: {
        channel_id: 'C123',
        user_id: 'U123',
        user_name: 'alice',
        text: 'status',
        trigger_id: 'trigger-1',
      },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('normalizes top-level Slack channel messages as their own thread root', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', null, null, 'slack_default')]: {
        folder: 'slack_ops',
        name: 'Ops',
      },
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
      [makeAgentThreadQueueKey('sl:C123', null, null, 'slack_default')]: {
        folder: 'slack_ops',
        name: 'Ops',
        trigger: '@Gantry',
      },
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

  it('strips only the leading Slack bot invocation and preserves the rest of the message', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', null, null, 'slack_default')]: {
        folder: 'slack_ops',
        name: 'Ops',
        trigger: '@Gantry',
      },
    });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('app_mention') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000300',
        thread_ts: '1710000000.000100',
        user: 'U123',
        text: 'yes <@U_BOT> you can request permission',
      },
    });
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000400',
        user: 'U123',
        text: '<@U_BOT>: deploy  now',
      },
    });

    expect(opts.onMessage).toHaveBeenNthCalledWith(
      1,
      'sl:C123',
      expect.objectContaining({
        content: 'yes <@U_BOT> you can request permission',
        thread_id: '1710000000.000100',
      }),
    );
    expect(opts.onMessage).toHaveBeenNthCalledWith(
      2,
      'sl:C123',
      expect.objectContaining({ content: '@Gantry deploy  now' }),
    );
  });

  it('keeps Slack thread replies in the root thread without requiring a new root', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', null, null, 'slack_default')]: {
        folder: 'slack_ops',
        name: 'Ops',
      },
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

  it('hydrates top-level Slack context with conversations.history', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    appRef.current.client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          channel: 'C123',
          ts: '1710000000.000100',
          user: 'U123',
          text: 'first',
        },
        {
          channel: 'C123',
          ts: '1710000001.000200',
          user: 'U123',
          text: 'second',
        },
      ],
    });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:00:02.000Z',
        external_message_id: '1710000002.000300',
      },
      limits: { channelMessages: 1, threadMessages: 50 },
    });

    expect(appRef.current.client.conversations.history).toHaveBeenCalledWith({
      channel: 'C123',
      latest: '1710000002.000300',
      inclusive: false,
      limit: 1,
    });
    expect(result).toMatchObject({
      providerId: 'slack',
      attempted: true,
      messages: [
        expect.objectContaining({
          chat_jid: 'sl:C123',
          provider: 'slack',
          content: 'first',
          external_message_id: '1710000000.000100',
          thread_id: undefined,
        }),
      ],
    });
  });

  it('hydrates edited top-level Slack history messages with current text', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    appRef.current.client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          channel: 'C123',
          ts: '1710000000.000100',
          user: 'U123',
          text: 'current edited text',
          edited: {
            user: 'U123',
            ts: '1710000000.000150',
          },
        },
        {
          channel: 'C123',
          ts: '1710000001.000200',
          user: 'U123',
          text: 'deleted text must stay excluded',
          subtype: 'message_deleted',
          edited: {
            user: 'U123',
            ts: '1710000001.000250',
          },
        },
      ],
    });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:00:02.000Z',
        external_message_id: '1710000002.000300',
      },
      limits: { channelMessages: 10, threadMessages: 50 },
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        content: 'current edited text',
        external_message_id: '1710000000.000100',
      }),
    ]);
  });

  it('derives Slack latest cursors from slash command message timestamps', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    appRef.current.client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [],
    });
    appRef.current.client.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [],
    });
    const latestMessage = {
      id: 'current',
      timestamp: '2024-03-09T16:00:02.123Z',
      external_message_id: 'trigger-1',
      thread_id: '1710000000.000100',
    };

    await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      latestMessage,
      limits: { channelMessages: 5, threadMessages: 5 },
    });
    await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      threadId: '1710000000.000100',
      latestMessage,
      limits: { channelMessages: 5, threadMessages: 5 },
    });

    const historyLatest =
      appRef.current.client.conversations.history.mock.calls[0]?.[0].latest;
    const repliesLatest =
      appRef.current.client.conversations.replies.mock.calls[0]?.[0].latest;
    expect(historyLatest).toBe('1710000002.123000');
    expect(repliesLatest).toBe('1710000002.123000');
    expect(historyLatest).toMatch(/^\d+\.\d+$/);
    expect(repliesLatest).toMatch(/^\d+\.\d+$/);
    expect(historyLatest).not.toBe('trigger-1');
    expect(repliesLatest).not.toBe('trigger-1');
  });

  it('hydrates Slack bot_message history and only marks configured self messages', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    appRef.current.client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          channel: 'C123',
          ts: '1710000000.000100',
          subtype: 'bot_message',
          bot_id: 'B_THIRD_PARTY',
          text: 'deploy finished',
        },
        {
          channel: 'C123',
          ts: '1710000001.000200',
          subtype: 'bot_message',
          user: 'U_BOT',
          bot_id: 'B_GANTRY',
          text: 'Gantry summary',
        },
      ],
    });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:00:02.000Z',
        external_message_id: '1710000002.000300',
      },
      limits: { channelMessages: 2, threadMessages: 50 },
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        sender: 'B_THIRD_PARTY',
        content: 'deploy finished',
        is_from_me: false,
        is_bot_message: false,
      }),
      expect.objectContaining({
        sender: 'U_BOT',
        content: 'Gantry summary',
        is_from_me: true,
        is_bot_message: true,
        delivery_status: 'sent',
      }),
    ]);
    expect(result.messages?.[0]).not.toHaveProperty('delivery_status');
  });

  it('hydrates Slack file metadata without downloading historical attachments', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    appRef.current.client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          channel: 'C123',
          ts: '1710000000.000100',
          user: 'U123',
          text: '',
          files: [
            {
              id: 'F_IMAGE',
              name: 'screen.png',
              mimetype: 'image/png',
              size: 4096,
              url_private_download: 'https://files.slack.test/screen.png',
            },
          ],
        },
        {
          channel: 'C123',
          ts: '1710000001.000200',
          user: 'U123',
          text: 'report attached',
          files: [
            {
              id: 'F_FILE',
              title: 'report.pdf',
              mimetype: 'application/pdf',
              size: 8192,
            },
          ],
        },
      ],
    });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:00:02.000Z',
        external_message_id: '1710000002.000300',
      },
      limits: { channelMessages: 2, threadMessages: 50 },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.messages).toEqual([
      expect.objectContaining({
        content: 'Attachment: screen.png',
        attachments: [
          expect.objectContaining({
            kind: 'image',
            contentType: 'image/png',
            sizeBytes: 4096,
            externalId: 'F_IMAGE',
          }),
        ],
      }),
      expect.objectContaining({
        content: 'report attached\nAttachment: report.pdf',
        attachments: [
          expect.objectContaining({
            kind: 'file',
            contentType: 'application/pdf',
            sizeBytes: 8192,
            externalId: 'F_FILE',
          }),
        ],
      }),
    ]);
  });

  it('preserves Slack history self-thread roots in top-level context', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    appRef.current.client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          channel: 'C123',
          ts: '1710000000.000100',
          thread_ts: '1710000000.000100',
          user: 'U123',
          text: 'root with replies',
        },
        {
          channel: 'C123',
          ts: '1710000001.000200',
          thread_ts: '1710000000.000100',
          user: 'U456',
          text: 'reply already in history',
        },
      ],
    });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:00:02.000Z',
        external_message_id: '1710000002.000300',
      },
      limits: { channelMessages: 2, threadMessages: 50 },
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        external_message_id: '1710000000.000100',
        thread_id: '1710000000.000100',
        reply_to_message_id: undefined,
      }),
      expect.objectContaining({
        external_message_id: '1710000001.000200',
        thread_id: '1710000000.000100',
        reply_to_message_id: '1710000000.000100',
      }),
    ]);
  });

  it('hydrates Slack thread context with conversations.replies and canonical thread_id', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    appRef.current.client.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          channel: 'C123',
          ts: '1710000000.000100',
          thread_ts: '1710000000.000100',
          user: 'U123',
          text: 'root',
        },
        {
          channel: 'C123',
          ts: '1710000001.000200',
          thread_ts: '1710000000.000100',
          user: 'U456',
          text: 'reply',
        },
      ],
    });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      threadId: '1710000000.000100',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:00:02.000Z',
        external_message_id: '1710000002.000300',
        thread_id: '1710000000.000100',
      },
      limits: { channelMessages: 30, threadMessages: 2 },
    });

    expect(appRef.current.client.conversations.replies).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '1710000000.000100',
      latest: '1710000002.000300',
      inclusive: false,
      limit: 2,
    });
    expect(result.messages).toEqual([
      expect.objectContaining({
        external_message_id: '1710000000.000100',
        thread_id: '1710000000.000100',
        reply_to_message_id: undefined,
      }),
      expect.objectContaining({
        external_message_id: '1710000001.000200',
        thread_id: '1710000000.000100',
        reply_to_message_id: '1710000000.000100',
      }),
    ]);
  });

  it('hydrates edited Slack thread replies with current text', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    appRef.current.client.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          channel: 'C123',
          ts: '1710000000.000100',
          thread_ts: '1710000000.000100',
          user: 'U123',
          text: 'root',
        },
        {
          channel: 'C123',
          ts: '1710000001.000200',
          thread_ts: '1710000000.000100',
          user: 'U456',
          text: 'current edited reply',
          edited: {
            user: 'U456',
            ts: '1710000001.000250',
          },
        },
        {
          channel: 'C123',
          ts: '1710000002.000300',
          thread_ts: '1710000000.000100',
          user: 'U789',
          text: 'unsupported join event must stay excluded',
          subtype: 'channel_join',
          edited: {
            user: 'U789',
            ts: '1710000002.000350',
          },
        },
      ],
    });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      threadId: '1710000000.000100',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:00:03.000Z',
        external_message_id: '1710000003.000400',
        thread_id: '1710000000.000100',
      },
      limits: { channelMessages: 30, threadMessages: 10 },
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        external_message_id: '1710000000.000100',
        content: 'root',
        thread_id: '1710000000.000100',
      }),
      expect.objectContaining({
        external_message_id: '1710000001.000200',
        content: 'current edited reply',
        thread_id: '1710000000.000100',
        reply_to_message_id: '1710000000.000100',
      }),
    ]);
  });

  it('hydrates long Slack threads through a bounded tail window and returns a bounded deduped selection', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    const reply = (index: number) => ({
      channel: 'C123',
      ts: `1710000${String(index).padStart(3, '0')}.000100`,
      thread_ts: '1710000000.000100',
      user: 'U456',
      text: `reply ${index}`,
    });
    appRef.current.client.conversations.replies
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          {
            channel: 'C123',
            ts: '1710000000.000100',
            thread_ts: '1710000000.000100',
            user: 'U123',
            text: 'root',
          },
          ...Array.from({ length: 49 }, (_, index) => reply(index + 1)),
        ],
        response_metadata: { next_cursor: 'thread-page-2' },
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          reply(49),
          ...Array.from({ length: 39 }, (_, index) => reply(index + 51)),
        ],
      });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      threadId: '1710000000.000100',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:01:31.000Z',
        external_message_id: '1710000091.000100',
        thread_id: '1710000000.000100',
      },
      limits: { channelMessages: 30, threadMessages: 50 },
    });

    expect(appRef.current.client.conversations.replies).toHaveBeenCalledTimes(
      2,
    );
    expect(appRef.current.client.conversations.replies).toHaveBeenNthCalledWith(
      1,
      {
        channel: 'C123',
        ts: '1710000000.000100',
        latest: '1710000091.000100',
        inclusive: false,
        limit: 50,
      },
    );
    expect(appRef.current.client.conversations.replies).toHaveBeenNthCalledWith(
      2,
      {
        channel: 'C123',
        ts: '1710000000.000100',
        latest: '1710000091.000100',
        inclusive: false,
        oldest: expect.any(String),
        limit: 39,
      },
    );
    const tailWindowCall =
      appRef.current.client.conversations.replies.mock.calls[1]?.[0];
    expect(Number(tailWindowCall.oldest)).toBeCloseTo(1709996491.0001, 5);
    expect(tailWindowCall).not.toHaveProperty('cursor');
    expect(result.messages).toHaveLength(50);
    expect(
      result.messages?.map((message) => message.external_message_id),
    ).toEqual([
      '1710000000.000100',
      ...Array.from(
        { length: 10 },
        (_, index) => `17100000${String(index + 1).padStart(2, '0')}.000100`,
      ),
      ...Array.from(
        { length: 39 },
        (_, index) => `1710000${String(index + 51).padStart(3, '0')}.000100`,
      ),
    ]);
    expect(
      new Set(result.messages?.map((message) => message.external_message_id)),
    ).toHaveProperty('size', 50);
    expect(result.messages?.at(-1)).toEqual(
      expect.objectContaining({
        external_message_id: '1710000089.000100',
        thread_id: '1710000000.000100',
        reply_to_message_id: '1710000000.000100',
      }),
    );
  });

  it('narrows dense Slack thread tail windows before selecting latest replies', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    const reply = (index: number) => ({
      channel: 'C123',
      ts: `1710000${String(index).padStart(3, '0')}.000100`,
      thread_ts: '1710000000.000100',
      user: 'U456',
      text: `reply ${index}`,
    });
    appRef.current.client.conversations.replies
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          {
            channel: 'C123',
            ts: '1710000000.000100',
            thread_ts: '1710000000.000100',
            user: 'U123',
            text: 'root',
          },
          ...Array.from({ length: 49 }, (_, index) => reply(index + 1)),
        ],
        response_metadata: { next_cursor: 'thread-page-2' },
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: Array.from({ length: 39 }, (_, index) => reply(index + 11)),
        response_metadata: { next_cursor: 'dense-tail-page' },
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: Array.from({ length: 39 }, (_, index) => reply(index + 52)),
      });

    const result = await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      threadId: '1710000000.000100',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:01:31.000Z',
        external_message_id: '1710000091.000100',
        thread_id: '1710000000.000100',
      },
      limits: { channelMessages: 30, threadMessages: 50 },
    });

    expect(appRef.current.client.conversations.replies).toHaveBeenCalledTimes(
      3,
    );
    const firstTailCall =
      appRef.current.client.conversations.replies.mock.calls[1]?.[0];
    const narrowedTailCall =
      appRef.current.client.conversations.replies.mock.calls[2]?.[0];
    expect(Number(narrowedTailCall.oldest)).toBeGreaterThan(
      Number(firstTailCall.oldest),
    );
    expect(
      result.messages?.map((message) => message.external_message_id),
    ).toEqual([
      '1710000000.000100',
      ...Array.from(
        { length: 10 },
        (_, index) => `17100000${String(index + 1).padStart(2, '0')}.000100`,
      ),
      ...Array.from(
        { length: 39 },
        (_, index) => `1710000${String(index + 52).padStart(3, '0')}.000100`,
      ),
    ]);
  });

  it('caps Slack thread tail window retries', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    const reply = (index: number) => ({
      channel: 'C123',
      ts: `1710000${String(index).padStart(3, '0')}.000100`,
      thread_ts: '1710000000.000100',
      user: 'U456',
      text: `reply ${index}`,
    });
    appRef.current.client.conversations.replies.mockResolvedValue({
      ok: true,
      messages: Array.from({ length: 39 }, (_, index) => reply(index + 11)),
      response_metadata: { next_cursor: 'still-dense' },
    });
    appRef.current.client.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          channel: 'C123',
          ts: '1710000000.000100',
          thread_ts: '1710000000.000100',
          user: 'U123',
          text: 'root',
        },
        ...Array.from({ length: 49 }, (_, index) => reply(index + 1)),
      ],
      response_metadata: { next_cursor: 'thread-page-2' },
    });

    await channel.hydrateConversationContext({
      conversationJid: 'sl:C123',
      threadId: '1710000000.000100',
      latestMessage: {
        id: 'current',
        timestamp: '2024-03-09T16:01:31.000Z',
        external_message_id: '1710000091.000100',
        thread_id: '1710000000.000100',
      },
      limits: { channelMessages: 30, threadMessages: 50 },
    });

    expect(appRef.current.client.conversations.replies).toHaveBeenCalledTimes(
      6,
    );
  });

  it('does not synthesize root threads for unrelated top-level channel chatter', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', null, null, 'slack_default')]: {
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

  it('stores Slack attachments for agent-qualified routes without exposing local paths', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
          providerAccountId: 'slack_default',
        },
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

  it('does not download Slack attachments through a different provider account route', async () => {
    const opts = createOpts();
    opts.providerAccountId = 'slack_alpha';
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        undefined,
        'slack_beta',
      )]: {
        folder: 'slack_ops',
        name: 'Ops',
        providerAccountId: 'slack_beta',
      },
    });
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
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

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('does not download Slack attachments for multiple matching route folders', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
          providerAccountId: 'slack_default',
        },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:triage',
        null,
        'slack_default',
      )]: {
        folder: 'slack_triage',
        name: 'Triage',
        providerAccountId: 'slack_default',
      },
    });
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: true,
        headers: { get: () => null },
        body: null,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      })),
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

    const message = opts.onMessage.mock.calls[0][1];
    expect(message.attachments[0]).toEqual(
      expect.objectContaining({ externalId: 'F123', kind: 'file' }),
    );
    expect(message.attachments[0]).not.toHaveProperty('storageRef');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('stores Slack attachments for the selected multi-agent route', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack_default')]:
        {
          folder: 'slack_ops',
          name: 'Ops',
          providerAccountId: 'slack_default',
        },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:triage',
        null,
        'slack_default',
      )]: {
        folder: 'slack_triage',
        name: 'Triage',
        providerAccountId: 'slack_default',
      },
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
        text: '@Ops see file',
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

    const message = opts.onMessage.mock.calls[0][1];
    expect(message.thread_id).toBe('1710000000.000100');
    expect(message.attachments[0]).toEqual(
      expect.objectContaining({ storageRef: 'attachments/report.pdf' }),
    );
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

  it('does not download Slack attachments for multiple exact thread route folders', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        '1710000000.000111',
        'slack_default',
      )]: {
        folder: 'slack_ops',
        name: 'Ops',
      },
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:triage',
        '1710000000.000111',
        'slack_default',
      )]: {
        folder: 'slack_triage',
        name: 'Triage',
      },
    });
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: true,
        headers: { get: () => null },
        body: null,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      })),
    );
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const handlers = appRef.current.eventHandlers.get('message') || [];
    await handlers[0]({
      event: {
        channel: 'C123',
        ts: '1710000000.000100',
        thread_ts: '1710000000.000111',
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

    const message = opts.onMessage.mock.calls[0][1];
    expect(message.thread_id).toBe('1710000000.000111');
    expect(message.attachments[0]).toEqual(
      expect.objectContaining({ externalId: 'F123', kind: 'file' }),
    );
    expect(message.attachments[0]).not.toHaveProperty('storageRef');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('does not download top-level Slack attachments through thread-scoped routes', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        '1710000000.000111',
        'slack_default',
      )]: {
        folder: 'slack_thread',
        name: 'Ops Thread',
        providerAccountId: 'slack_default',
      },
    });
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

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('stores Slack attachments for exact thread-scoped agent routes', async () => {
    const opts = createOpts();
    opts.conversationRoutes.mockReturnValue({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        '1710000000.000111',
        'slack_default',
      )]: {
        folder: 'slack_thread',
        name: 'Ops Thread',
        providerAccountId: 'slack_default',
      },
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
        ts: '1710000000.000222',
        thread_ts: '1710000000.000111',
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
        thread_id: '1710000000.000111',
        attachments: [
          expect.objectContaining({ storageRef: 'attachments/report.pdf' }),
        ],
      }),
    );
    expect(mkdirSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_thread/attachments',
      { recursive: true, mode: 0o700 },
    );
    expect(writeSpy).toHaveBeenCalledWith(
      '/tmp/test-groups/slack_thread/attachments/report.pdf',
      expect.any(Buffer),
      { mode: 0o600 },
    );
  });

  it('resets Slack attachment file mode when overwriting buffered downloads', async () => {
    vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isSymbolicLink: () => false,
    } as any);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    const chmodSpy = vi.spyOn(fs, 'chmodSync').mockReturnValue(undefined);

    await expect(
      writeSlackAttachmentResponse(
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

    await expect(
      writeSlackAttachmentResponse(
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

  it('uploads outbound file content through the Slack external upload flow', async () => {
    const uploadFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', uploadFetch);
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    await channel.sendMessage('sl:C1234567890', 'Rendered.', {
      threadId: '1710000000.000111',
      files: [
        {
          filename: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: 4,
          content: new Uint8Array([0, 1, 2, 3]),
        },
      ],
    });

    expect(
      appRef.current.client.files.getUploadURLExternal,
    ).toHaveBeenCalledWith({ filename: 'clip.mp4', length: 4 });
    expect(uploadFetch).toHaveBeenCalledWith(
      'https://files.slack.com/upload/v1/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    expect(
      Buffer.from(uploadFetch.mock.calls[0]?.[1]?.body as Uint8Array),
    ).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(
      appRef.current.client.files.completeUploadExternal,
    ).toHaveBeenCalledWith({
      files: [{ id: 'F123', title: 'clip.mp4' }],
      channel_id: 'C1234567890',
      thread_ts: '1710000000.000111',
    });
  });

  it('posts a visible per-file fallback when Slack upload fails', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(
      appRef.current.client.files.getUploadURLExternal,
    ).mockRejectedValueOnce(new Error('upload unavailable'));

    const result = await channel.sendMessage('sl:C1234567890', 'Rendered.', {
      files: [
        {
          filename: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: 4,
          content: new Uint8Array([0, 1, 2, 3]),
        },
      ],
    });

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(appRef.current.client.chat.postMessage).toHaveBeenNthCalledWith(2, {
      channel: 'C1234567890',
      text: 'Attachment unavailable in Slack: clip.mp4 upload failed.',
    });
    expect(result).toMatchObject({
      warnings: ['slack.attachment_upload_failed'],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jid: 'sl:C1234567890',
        path: 'clip.mp4',
        reason: 'clip.mp4 upload failed.',
      }),
      'Slack attachment upload failed',
    );
  });

  it('fails delivery when both Slack upload and visible fallback fail', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(
      appRef.current.client.files.getUploadURLExternal,
    ).mockRejectedValueOnce(new Error('upload unavailable'));
    vi.mocked(appRef.current.client.chat.postMessage)
      .mockResolvedValueOnce({ ok: true, ts: '1710000000.100200' })
      .mockRejectedValue(new Error('fallback unavailable'));

    await expect(
      channel.sendMessage('sl:C1234567890', 'Rendered.', {
        files: [
          {
            filename: 'clip.mp4',
            contentType: 'video/mp4',
            sizeBytes: 4,
            content: new Uint8Array([0, 1, 2, 3]),
          },
        ],
      }),
    ).rejects.toThrow('fallback unavailable');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jid: 'sl:C1234567890',
        path: 'clip.mp4',
        error: expect.objectContaining({ message: 'fallback unavailable' }),
      }),
      'Slack attachment fallback message failed',
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
      headline: 'Searching the web',
      status: 'running',
      stop: { label: 'Stop', actionToken: 'stop-token-1' },
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
      status: 'done',
      stop: { label: 'Stop', actionToken: 'stale-stop-token' },
      items: [{ id: 'a', title: 'A', status: 'completed' }],
    });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        channel: 'C1234567890',
        thread_ts: '1710000000.000111',
      }),
    );
    expect(JSON.stringify(postMessage.mock.calls[0]?.[0])).toContain(
      '⏳ Searching the web',
    );
    expect(JSON.stringify(postMessage.mock.calls[0]?.[0])).not.toContain(
      'stop-token-1',
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
    expect(JSON.stringify(update.mock.calls[0]?.[0])).not.toContain(
      'stale-stop-token',
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
      ],
    });

    const payload = appRef.current.client.chat.postMessage.mock.calls[0]?.[0];
    expect(
      payload.blocks[1].elements.map((button: any) => button.text.text),
    ).toEqual(['Retry now', 'Pause job']);
    expect(payload.blocks[1].elements[0]).toEqual(
      expect.objectContaining({
        action_id: 'gantry_message_action',
        value: expect.stringContaining('"kind":"scheduler_run_now"'),
      }),
    );
  });

  it('routes Slack scheduler run-now action buttons through the message action callback', async () => {
    const opts = {
      ...createOptsWithApproverHook(['U_APPROVER']),
      onMessageAction: vi.fn(),
    };
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
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
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U_APPROVER' },
        message: { thread_ts: '1710000000.000111' },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(opts.onMessageAction).toHaveBeenCalledWith({
      kind: 'scheduler_run_now',
      conversationJid: 'sl:C1234567890',
      providerAccountId: 'slack_default',
      threadId: '1710000000.000111',
      userId: 'U_APPROVER',
      jobId: 'job-1',
      runId: 'run-1',
    });
    expect(appRef.current.client.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it('does not render Slack live stop action buttons', async () => {
    const opts = {
      ...createOptsWithApproverHook(['U_APPROVER']),
      providerAccountId: 'slack_alpha',
      onMessageAction: vi.fn(),
    };
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    await channel.sendMessage('sl:C1234567890', 'Working...', {
      providerAccountId: 'slack_beta',
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });
    const payload = appRef.current.client.chat.postMessage.mock.calls[0]?.[0];
    expect(payload.blocks).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('live_turn_stop');
    expect(JSON.stringify(payload)).not.toContain('Stop');
  });

  it('ignores stale Slack live stop action callbacks', async () => {
    const opts = {
      ...createOptsWithApproverHook(['U_APPROVER']),
      providerAccountId: 'slack_alpha',
      onMessageAction: vi.fn(),
    };
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_message_action',
    );
    expect(actionHandler).toBeDefined();
    const ack = vi.fn();
    await actionHandler({
      ack,
      action: {
        value:
          '{"kind":"live_turn_stop","actionToken":"token-1","providerAccountId":"slack_beta"}',
      },
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U_APPROVER' },
        message: { thread_ts: '1710000000.000111' },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(opts.onMessageAction).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.postEphemeral).not.toHaveBeenCalled();
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

  it('adds bounded jitter to Slack rate-limit retry delays', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);

    const retryDelayMs = slackRateLimitRetryDelayMs({ status: 429 });

    expect(retryDelayMs).toBeGreaterThan(1000);
    expect(retryDelayMs).toBeLessThanOrEqual(1250);
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

  it('clears Slack thread status for replace-only done without chat text', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall).mockResolvedValueOnce({
      ok: true,
    });

    await channel.sendProgressUpdate('sl:C1234567890', 'Done.', {
      done: true,
      replaceOnly: true,
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: '',
      },
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('starts Slack thread status for action-only progress without chat text', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall).mockResolvedValueOnce({
      ok: true,
    });

    await channel.sendProgressUpdate('sl:C1234567890', '', {
      actionOnly: true,
      threadId: '1710000000.000111',
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: 'Looking into it...',
      },
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('does not create a fresh Slack Done progress reply', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall).mockResolvedValueOnce({
      ok: true,
    });

    await channel.sendProgressUpdate('sl:C1234567890', 'Done.', {
      done: true,
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: '',
      },
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('keeps terminal Slack failure text in assistant thread status without chat text', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall).mockResolvedValueOnce({
      ok: true,
    });

    await channel.sendProgressUpdate('sl:C1234567890', 'I hit an issue.', {
      done: true,
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: 'I hit an issue.',
      },
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('falls back to chat for terminal Slack failure when thread status fails after status progress', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'missing_scope' });

    await channel.sendProgressUpdate('sl:C1234567890', 'Gathering context...', {
      threadId: '1710000000.000111',
    });
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    appRef.current.client.chat.postMessage.mockClear();
    appRef.current.client.chat.update.mockClear();

    await channel.sendProgressUpdate('sl:C1234567890', 'I hit an issue.', {
      done: true,
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).toHaveBeenLastCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: 'I hit an issue.',
      },
    );
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1234567890',
      text: 'I hit an issue.',
      thread_ts: '1710000000.000111',
    });
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('writes Slack assistant thread status from progress copy without chat text', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall).mockResolvedValueOnce({
      ok: true,
    });

    await channel.sendProgressUpdate('sl:C1234567890', 'Gathering context...', {
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: 'Gathering context...',
      },
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('falls back to chat when Slack thread status returns ok false', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(appRef.current.client.apiCall).mockResolvedValueOnce({
      ok: false,
      error: 'missing_scope',
    });

    await channel.sendProgressUpdate('sl:C1234567890', 'Gathering context...', {
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: 'Gathering context...',
      },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C1234567890',
        threadTs: '1710000000.000111',
        key: 'progress:sl:C1234567890:1710000000.000111',
        statusText: 'Gathering context...',
        slackError: 'missing_scope',
      }),
      'Progress lifecycle slack thread status failed',
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Progress lifecycle slack thread status sent',
    );
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1234567890',
      text: 'Gathering context...',
      thread_ts: '1710000000.000111',
    });
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('falls back to chat when Slack thread status rejects', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    const err = new Error('slack unavailable');
    vi.mocked(appRef.current.client.apiCall).mockRejectedValueOnce(err);

    await channel.sendProgressUpdate('sl:C1234567890', 'Gathering context...', {
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: 'Gathering context...',
      },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C1234567890',
        threadTs: '1710000000.000111',
        key: 'progress:sl:C1234567890:1710000000.000111',
        statusText: 'Gathering context...',
        err,
      }),
      'Progress lifecycle slack thread status failed',
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Progress lifecycle slack thread status sent',
    );
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1234567890',
      text: 'Gathering context...',
      thread_ts: '1710000000.000111',
    });
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
  });

  it('falls back to the existing chat progress handle for terminal Slack failure text', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall)
      .mockResolvedValueOnce({ ok: false, error: 'missing_scope' })
      .mockResolvedValueOnce({ ok: false, error: 'missing_scope' });

    await channel.sendProgressUpdate('sl:C1234567890', 'Gathering context...', {
      threadId: '1710000000.000111',
    });
    appRef.current.client.chat.postMessage.mockClear();
    appRef.current.client.chat.update.mockClear();

    await channel.sendProgressUpdate('sl:C1234567890', 'I hit an issue.', {
      done: true,
      threadId: '1710000000.000111',
    });

    expect(appRef.current.client.apiCall).toHaveBeenLastCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: 'I hit an issue.',
      },
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
      channel: 'C1234567890',
      ts: '1710000000.100200',
      text: 'I hit an issue.',
      blocks: [],
    });
  });

  it('keeps action-only Slack progress chat-silent when thread status fails', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall).mockResolvedValueOnce({
      ok: false,
      error: 'missing_scope',
    });

    await channel.sendProgressUpdate('sl:C1234567890', '', {
      actionOnly: true,
      threadId: '1710000000.000111',
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'assistant.threads.setStatus',
      {
        channel_id: 'C1234567890',
        thread_ts: '1710000000.000111',
        status: 'Looking into it...',
      },
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
    await channel.sendProgressUpdate('sl:C1234567890', 'Done.', {
      done: true,
      replaceOnly: true,
    });
    expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
      channel: 'C1234567890',
      ts: '1710000000.100200',
      text: 'Done.',
      blocks: [],
    });
    appRef.current.client.chat.postMessage.mockClear();
    appRef.current.client.chat.update.mockClear();

    await channel.sendProgressUpdate('sl:C1234567890', 'Done.', {
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
    await channel.sendProgressUpdate('sl:C1234567890', 'Done.', {
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
      text: 'Done.',
      blocks: [],
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
    await channel.sendProgressUpdate('sl:C1234567890', 'Done.', {
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

    await channel.sendProgressUpdate('sl:C1234567890', 'Done.', {
      done: true,
      replaceOnly: true,
      generation: 1,
    });
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();

    await channel.sendProgressUpdate('sl:C1234567890', 'Done.', {
      done: true,
      replaceOnly: true,
      generation: 3,
    });
    expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
      channel: 'C1234567890',
      ts: '1710000000.100200',
      text: 'Done.',
      blocks: [],
    });
  });

  it('lets newer replace-only Slack progress take over the existing generation', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U123']) as any,
    );
    await channel.connect();

    await channel.sendProgressUpdate('sl:C1234567890', 'Waiting...', {
      generation: 4,
    });
    appRef.current.client.chat.postMessage.mockClear();
    appRef.current.client.chat.update.mockClear();

    await channel.sendProgressUpdate('sl:C1234567890', 'Waiting...', {
      replaceOnly: true,
      generation: 7,
    });
    await channel.sendProgressUpdate('sl:C1234567890', 'Stale waiting...', {
      replaceOnly: true,
      generation: 6,
    });

    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();

    await channel.sendProgressUpdate('sl:C1234567890', 'Continuing...', {
      replaceOnly: true,
      generation: 8,
    });

    expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
      channel: 'C1234567890',
      ts: '1710000000.100200',
      text: 'Continuing...',
      blocks: [],
    });
  });

  it('restores Slack progress handles after restart for newer replace-only generations', async () => {
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
      await first.sendProgressUpdate('sl:C1234567890', 'Waiting...', {
        generation: 4,
      });

      const second = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts() as any,
      );
      await second.connect();
      appRef.current.client.chat.postMessage.mockClear();
      appRef.current.client.chat.update.mockClear();
      await second.sendProgressUpdate('sl:C1234567890', 'Waiting...', {
        replaceOnly: true,
        generation: 7,
      });
      await second.sendProgressUpdate('sl:C1234567890', 'Stale waiting...', {
        replaceOnly: true,
        generation: 6,
      });

      expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
      expect(appRef.current.client.chat.update).not.toHaveBeenCalled();

      await second.sendProgressUpdate('sl:C1234567890', 'Continuing...', {
        replaceOnly: true,
        generation: 8,
      });

      expect(appRef.current.client.chat.update).toHaveBeenCalledWith({
        channel: 'C1234567890',
        ts: '1710000000.100200',
        text: 'Continuing...',
        blocks: [],
      });
    } finally {
      if (savedHome === undefined) delete process.env.GANTRY_HOME;
      else process.env.GANTRY_HOME = savedHome;
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('drops persisted Slack progress handles for a different channel', async () => {
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
      await first.sendProgressUpdate('sl:C1234567890', 'Waiting...', {
        generation: 4,
      });

      const runDir = `${runtimeHome}/run`;
      const stateFile = fs
        .readdirSync(runDir)
        .find((name) => name.startsWith('slack-progress-state-'));
      expect(stateFile).toBeTruthy();
      const statePath = `${runDir}/${stateFile}`;
      const entries = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any[];
      entries[0][1].channelId = 'C9999999999';
      fs.writeFileSync(statePath, JSON.stringify(entries));

      const second = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts() as any,
      );
      await second.connect();
      appRef.current.client.chat.postMessage.mockClear();
      appRef.current.client.chat.update.mockClear();

      await second.sendProgressUpdate('sl:C1234567890', 'Continuing...', {
        replaceOnly: true,
        generation: 5,
      });

      expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
      expect(appRef.current.client.chat.update).not.toHaveBeenCalled();

      await second.sendProgressUpdate('sl:C1234567890', 'Working again...', {
        generation: 6,
      });

      expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C1234567890',
        text: 'Working again...',
      });
      expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
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

    const approvalPromise = requestSlackPermissionApproval(channel, 'sl:C123', {
      requestId: 'perm-cmd',
      sourceAgentFolder: 'slack_main',
      targetJid: 'sl:C123',
      threadId: '1711111111.000100',
      toolName: 'Bash',
      toolInput: {
        command: 'git status --short',
      },
    });
    await flushSlackPromptRegistration();
    const postCall = vi
      .mocked(appRef.current.client.chat.postEphemeral)
      .mock.calls.at(-1)?.[0];
    expect(postCall?.user).toBe('U_APPROVER');
    expect(postCall?.thread_ts).toBe('1711111111.000100');
    expect(postCall?.text).toContain(
      'Approval applies to the parent conversation.',
    );
    expect(JSON.stringify(postCall?.blocks || [])).not.toContain(
      'git status --short',
    );
    const actionsBlock = postCall?.blocks?.find(
      (block: any) => block.type === 'actions',
    ) as { elements?: Array<{ action_id?: string }> } | undefined;
    const actionIds = (actionsBlock?.elements || []).map(
      (element) => element.action_id,
    );
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(actionIds).toContain('gantry_perm_full_view');
    expect(actionIds).toContain('gantry_perm_decision_allow_once');

    for (const actionId of SLACK_PERMISSION_DECISION_ACTION_IDS) {
      expect(appRef.current.actionHandlers.has(actionId)).toBe(true);
    }
    const fullViewHandler = appRef.current.actionHandlers.get(
      'gantry_perm_full_view',
    );
    await fullViewHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C123' },
        trigger_id: 'trigger-full-view',
        user: { id: 'U_APPROVER' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_full_view'),
        ),
      },
    });
    expect(appRef.current.client.views.open).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_id: 'trigger-full-view',
        view: expect.objectContaining({
          callback_id: 'gantry_perm_full_view_modal',
          blocks: expect.arrayContaining([
            expect.objectContaining({
              text: expect.objectContaining({
                text: expect.stringContaining('git status --short'),
              }),
            }),
          ]),
        }),
      }),
    );
    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    );
    const respond = vi.fn().mockResolvedValue({});
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        response_url: 'https://hooks.slack.test/actions/perm-cmd',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: true }),
    );
    expect(respond).toHaveBeenCalledWith({ delete_original: true });
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('opens durable Slack permission full-view payloads after channel restart', async () => {
    const request: PermissionApprovalRequest = {
      requestId: 'perm-durable-full-view',
      sourceAgentFolder: 'slack_main',
      targetJid: 'sl:C123',
      decisionPolicy: 'same_channel' as const,
      toolName: 'Bash',
    };
    configureSlackPermissionRequest(request);
    await bindPendingPermissionInteractionMessage({
      request,
      decisionOptions: ['allow_once', 'cancel'],
      callbackId: 'slack-full-view-alias',
      fullView: {
        label: 'View full command',
        title: 'Full command',
        filename: 'permission-command.txt',
        content: 'git status --short',
      },
    });
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const fullViewHandler = appRef.current.actionHandlers.get(
      'gantry_perm_full_view',
    );
    await fullViewHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C123' },
        trigger_id: 'trigger-full-view',
        user: { id: 'U_APPROVER' },
      },
      action: {
        value: JSON.stringify({
          callback: {
            providerAlias: 'slack-full-view-alias',
            scope: {
              appId: 'default',
              sourceAgentFolder: 'slack_main',
              interactionId: 'perm-durable-full-view',
            },
            matchKind: 'individual',
          },
        }),
      },
    });

    expect(appRef.current.client.views.open).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_id: 'trigger-full-view',
        view: expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              text: expect.objectContaining({
                text: expect.stringContaining('git status --short'),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it('replaces an approved Slack ephemeral through response_url when removal fails', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const respond = vi
      .fn()
      .mockRejectedValueOnce(new Error('delete_original failed'))
      .mockResolvedValueOnce({});

    const approvalPromise = requestSlackPermissionApproval(channel, 'sl:C123', {
      requestId: 'perm-delete-fallback',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    });
    await flushSlackPromptRegistration();
    await appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    )?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.test/actions/perm-delete-fallback',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });

    await expect(approvalPromise).resolves.toMatchObject({ approved: true });
    expect(respond).toHaveBeenNthCalledWith(1, { delete_original: true });
    expect(respond).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replace_original: true,
        text: expect.stringContaining('Allowed once:'),
      }),
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('routes recovered Slack clicks through application orchestrator transport hooks', async () => {
    const opts = createOptsWithApproverHook(['U_APPROVER']);
    const runtimeSettings = opts.runtimeSettings;
    opts.runtimeSettings = () => {
      const settings = runtimeSettings();
      settings.bindings.slack_long_test_binding = {
        ...settings.bindings.slack_test_binding,
        conversation: 'slack_long_test_conversation',
      };
      return settings;
    };
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    const requests: PermissionApprovalRequest[] = ['one', 'two'].map(
      (suffix) => ({
        requestId: `perm-recovered-${suffix}`,
        sourceAgentFolder: 'slack_main',
        targetJid: 'sl:C123',
        toolName: 'Bash',
        decisionOptions: ['allow_once', 'cancel'],
      }),
    );
    const batch = createPermissionBatchRequest(requests, [
      '1. Command',
      '2. Command',
    ]);
    batch.approvalContextJid = 'sl:C1234567890';
    const repository = configureSlackPermissionRequest(batch);
    const providerAlias = 'slack-recovered-batch';
    await bindPendingPermissionInteractionMessage({
      request: batch,
      decisionOptions: ['allow_persistent_rule', 'cancel'],
      callbackId: providerAlias,
    });
    const respond = vi.fn().mockResolvedValue({});
    const action = {
      callback: {
        providerAlias,
        scope: {
          appId: 'default',
          sourceAgentFolder: 'slack_main',
          interactionId: batch.requestId,
        },
        matchKind: 'batch',
      },
      decision: 'allow_once',
    };

    await appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    )?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        channel: { id: 'C123' },
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: { value: JSON.stringify(action) },
    });
    expect(repository.claimPendingPermissionCallback).not.toHaveBeenCalled();

    await appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_persistent_rule',
    )?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.test/actions/recovered-batch',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: {
        value: JSON.stringify({
          ...action,
          decision: 'allow_persistent_rule',
        }),
      },
    });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        replace_original: true,
        text: expect.stringMatching(/cancel|denied/i),
      }),
    );
    expect(repository.claimPendingPermissionCallback).toHaveBeenCalledOnce();
    expect(repository.expirePendingPermissionReviewEach).toHaveBeenCalledOnce();
    expect(opts.isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'sl:C1234567890' }),
    );
  });

  it('terminalizes a recovered Slack batch with the durable callback id', async () => {
    const opts = createOptsWithApproverHook(['U_APPROVER']);
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts as any);
    await channel.connect();
    const requests: PermissionApprovalRequest[] = ['one', 'two'].map(
      (suffix) => ({
        requestId: `perm-terminalize-${suffix}`,
        sourceAgentFolder: 'slack_main',
        targetJid: 'sl:C123',
        toolName: 'Bash',
        decisionOptions: ['allow_once', 'cancel'],
      }),
    );
    const batch = createPermissionBatchRequest(requests, [
      '1. Command',
      '2. Command',
    ]);
    const repository = configureSlackPermissionRequest(batch);
    const providerAlias = 'slack-terminalize-batch';
    await bindPendingPermissionInteractionMessage({
      request: batch,
      decisionOptions: ['allow_persistent_rule', 'cancel'],
      callbackId: providerAlias,
    });
    const terminalize = vi
      .spyOn(channel as any, 'terminalizePermissionPrompt')
      .mockResolvedValue(true);

    await appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_persistent_rule',
    )?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue({}),
      body: {
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.test/actions/terminalize-batch',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: {
        value: JSON.stringify({
          callback: {
            providerAlias,
            scope: {
              appId: 'default',
              sourceAgentFolder: 'slack_main',
              interactionId: batch.requestId,
            },
            matchKind: 'batch',
          },
          decision: 'allow_persistent_rule',
        }),
      },
    });

    expect(terminalize).toHaveBeenCalledWith(
      batch.requestId,
      expect.any(Object),
      expect.any(String),
      expect.any(Function),
    );
  });

  it('resolves every Slack permission waiter on disconnect after a retryable durable claim', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const first = requestSlackPermissionApproval(channel, 'sl:C123', {
      requestId: 'perm-disconnect-first',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    });
    await flushSlackPromptRegistration();
    const second = requestSlackPermissionApproval(channel, 'sl:C123', {
      requestId: 'perm-disconnect-retryable',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    });
    await flushSlackPromptRegistration();
    const repository = configureSlackPermissionRequest({
      requestId: 'perm-disconnect-retryable',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    });
    repository.claimPendingPermissionCallback.mockRejectedValue(
      new Error('database unavailable'),
    );

    await appRef.current.actionHandlers.get('gantry_perm_decision_cancel')?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue({}),
      body: {
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.test/actions/retryable',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_cancel'),
        ),
      },
    });
    await channel.disconnect();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'Slack channel disconnected',
      }),
      expect.objectContaining({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'Slack channel disconnected',
      }),
    ]);
  });

  it('preserves a Slack permission waiter owned by an in-flight winner on disconnect', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const request: PermissionApprovalRequest = {
      requestId: 'perm-disconnect-winner',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    };
    const repository = configureSlackPermissionRequest(request);
    const approval = channel.requestPermissionApproval('sl:C123', request);
    await flushSlackPromptRegistration();
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'slack_main',
      interactionId: request.requestId,
    };
    const group = await repository.findPendingPermissionPrompt({ scope });
    group!.prompt.claim = {
      id: 'holder',
      scope,
      intent: {
        mode: 'allow_once',
        approverRef: 'owner',
        decidedAt: '2026-07-17T00:00:00.000Z',
      },
      match: {
        kind: 'individual',
        canonicalId: request.requestId,
        providerAliases: [],
      },
    };
    group!.prompt.settlementState = 'claimed';
    repository.claimPendingPermissionCallback.mockResolvedValue(null);
    let resolved = false;
    void approval.then(() => {
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
    pending.resolve({ approved: true, mode: 'allow_once', decidedBy: 'owner' });
    prompts.clear();
    await approval;
  });

  it('resolves an ownerless Slack permission waiter on disconnect', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const request: PermissionApprovalRequest = {
      requestId: 'perm-disconnect-ownerless',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    };
    const approval = requestSlackPermissionApproval(
      channel,
      'sl:C123',
      request,
    );
    await flushSlackPromptRegistration();
    configurePendingInteractionDurability({
      repository: {
        claimPendingPermissionCallback: vi.fn(async () => null),
        findPendingPermissionPrompt: vi.fn(async () => null),
      } as never,
    });

    await channel.disconnect();

    await expect(approval).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'Slack channel disconnected',
    });
    expect((channel as any).pendingPermissionPrompts.size).toBe(0);
  });

  it('drops matching Slack permission and question waiters without resolving them', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const permissionRequest: PermissionApprovalRequest = {
      requestId: 'permission-drop-shadow',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    };
    const questionRequest = {
      requestId: 'question-drop-shadow',
      sourceAgentFolder: 'slack_main',
      questions: [
        {
          header: 'Continue',
          question: 'Continue?',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'Continue' }],
        },
      ],
    };
    const approval = requestSlackPermissionApproval(
      channel,
      'sl:C123',
      permissionRequest,
    );
    await flushSlackPromptRegistration();
    const answer = requestSlackUserAnswer(
      channel,
      'sl:C1234567890',
      questionRequest,
    );
    await flushSlackPromptRegistration();
    expect((channel as any).pendingPermissionPrompts.size).toBe(1);
    expect((channel as any).pendingUserQuestions.size).toBe(1);
    let approvalResolved = 0;
    let answerResolved = 0;
    void approval.then(() => {
      approvalResolved += 1;
    });
    void answer.then(() => {
      answerResolved += 1;
    });

    channel.dropPendingInteraction('permission', permissionRequest);
    channel.dropPendingInteraction('question', questionRequest);
    await Promise.resolve();

    expect((channel as any).pendingPermissionPrompts.size).toBe(0);
    expect((channel as any).pendingUserQuestions.size).toBe(0);
    expect(approvalResolved).toBe(0);
    expect(answerResolved).toBe(0);
    await channel.disconnect();
  });

  it('claims an individual Slack permission once and resolves after terminalization', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_FIRST', 'U_SECOND']) as any,
    );
    await channel.connect();
    const request = {
      requestId: 'perm-individual-race',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    };
    const raceRepository = configureSlackPermissionRequest(request);
    const approvalPromise = channel.requestPermissionApproval(
      'sl:C123',
      request,
    );
    const resolved = vi.fn();
    void approvalPromise.then(resolved);
    await vi.waitFor(() =>
      expect(raceRepository.bindPendingPermissionPrompt).toHaveBeenCalledTimes(
        2,
      ),
    );

    let finishTerminalization!: () => void;
    const terminalization = new Promise<void>((resolve) => {
      finishTerminalization = resolve;
    });
    const firstRespond = vi.fn(async () => terminalization);
    const firstClick = appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    )?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: firstRespond,
      body: {
        response_url: 'https://hooks.slack.test/actions/first',
        user: { id: 'U_FIRST', name: 'First Approver' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });
    await vi.waitFor(() =>
      expect(firstRespond).toHaveBeenCalledWith({ delete_original: true }),
    );

    const secondRespond = vi.fn().mockResolvedValue({});
    await appRef.current.actionHandlers.get('gantry_perm_decision_cancel')?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: secondRespond,
      body: {
        response_url: 'https://hooks.slack.test/actions/second',
        user: { id: 'U_SECOND', name: 'Second Approver' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_cancel'),
        ),
      },
    });

    expect(secondRespond).toHaveBeenCalledWith({
      replace_original: true,
      text: 'This permission request was already decided.',
    });
    expect(resolved).not.toHaveBeenCalled();
    finishTerminalization();
    await firstClick;
    await expect(approvalPromise).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'U_FIRST',
    });
    expect(raceRepository.claimPendingPermissionCallback).toHaveBeenCalledTimes(
      2,
    );
  });

  it('preserves the winner when timeout fires after another callback claimed', async () => {
    vi.useFakeTimers();
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_FIRST']) as any,
    );
    await channel.connect();
    const request = {
      requestId: 'perm-timeout-claim-race',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    };
    const raceRepository = configureSlackPermissionRequest(request);
    const approvalPromise = channel.requestPermissionApproval(
      'sl:C123',
      request,
    );
    const resolved = vi.fn();
    void approvalPromise.then(resolved);
    await vi.waitFor(() =>
      expect(raceRepository.bindPendingPermissionPrompt).toHaveBeenCalledTimes(
        2,
      ),
    );

    let finishTerminalization!: () => void;
    const terminalization = new Promise<void>((resolve) => {
      finishTerminalization = resolve;
    });
    const respond = vi.fn(async () => terminalization);
    const winner = appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    )?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        response_url: 'https://hooks.slack.test/actions/winner',
        user: { id: 'U_FIRST', name: 'First Approver' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ delete_original: true }),
    );

    await vi.advanceTimersByTimeAsync(300_000);

    expect(resolved).not.toHaveBeenCalled();
    expect((channel as any).pendingPermissionPrompts.size).toBe(1);
    finishTerminalization();
    await winner;
    await expect(approvalPromise).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'U_FIRST',
    });
    expect(raceRepository.claimPendingPermissionCallback).toHaveBeenCalledTimes(
      2,
    );
    vi.useRealTimers();
  });

  it('allows an authorized approver whose display name is System', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_SYSTEM']) as any,
    );
    await channel.connect();
    const request = {
      requestId: 'perm-reserved-display-name',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    };
    const repository = configureSlackPermissionRequest(request);
    const approvalPromise = channel.requestPermissionApproval(
      'sl:C123',
      request,
    );
    await vi.waitFor(() =>
      expect(repository.bindPendingPermissionPrompt).toHaveBeenCalledTimes(2),
    );

    await appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    )?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue({}),
      body: {
        response_url: 'https://hooks.slack.test/actions/system-display',
        user: { id: 'U_SYSTEM', name: 'System' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });

    await expect(approvalPromise).resolves.toMatchObject({
      approved: true,
      decidedBy: 'U_SYSTEM',
    });
    expect(repository.claimPendingPermissionCallback).toHaveBeenCalledWith({
      claim: expect.objectContaining({
        intent: expect.objectContaining({ approverRef: 'U_SYSTEM' }),
      }),
    });
  });

  it('leaves a Slack permission ephemeral stale without response_url and posts no receipt', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const approvalPromise = requestSlackPermissionApproval(channel, 'sl:C123', {
      requestId: 'perm-no-response-url',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
      toolInput: { command: 'cat /private/customer.txt' },
    });
    await flushSlackPromptRegistration();
    const respond = vi.fn().mockResolvedValue({});
    const actionValue = latestSlackPermissionActionValue(
      'gantry_perm_decision_cancel',
    );

    await appRef.current.actionHandlers.get('gantry_perm_decision_cancel')?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        channel: { id: 'C123' },
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: {
        value: JSON.stringify(actionValue),
      },
    });

    let settled = false;
    void approvalPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.delete).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();

    const retryRespond = vi.fn().mockResolvedValue({});
    await appRef.current.actionHandlers.get('gantry_perm_decision_cancel')?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: retryRespond,
      body: {
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.test/actions/retry',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: { value: JSON.stringify(actionValue) },
    });
    await expect(approvalPromise).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
    });
  });

  it('keeps identical Slack request ids scoped to the authorized agent', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const firstRequest = {
      requestId: 'shared-request-id',
      sourceAgentFolder: 'agent_one',
      targetJid: 'sl:C123',
      toolName: 'Bash',
    };
    const firstRepository = configureSlackPermissionRequest(firstRequest);
    const firstApproval = channel.requestPermissionApproval(
      'sl:C123',
      firstRequest,
    );
    await flushSlackPromptRegistration();
    const firstValue = latestSlackPermissionActionValue(
      'gantry_perm_decision_allow_once',
    );

    const secondRequest = {
      ...firstRequest,
      sourceAgentFolder: 'agent_two',
    };
    const secondRepository = configureSlackPermissionRequest(secondRequest);
    const secondApproval = channel.requestPermissionApproval(
      'sl:C123',
      secondRequest,
    );
    await flushSlackPromptRegistration();
    const secondValue = latestSlackPermissionActionValue(
      'gantry_perm_decision_cancel',
    );
    configurePendingInteractionDurability({
      repository: {
        findPendingPermissionPrompt: vi.fn(async (input) => {
          const first =
            await firstRepository.findPendingPermissionPrompt(input);
          return (
            first ?? (await secondRepository.findPendingPermissionPrompt(input))
          );
        }),
        findPendingInteractionByIdempotencyKey: vi.fn(async (input) => {
          const first =
            await firstRepository.findPendingInteractionByIdempotencyKey(input);
          return (
            first ??
            (await secondRepository.findPendingInteractionByIdempotencyKey(
              input,
            ))
          );
        }),
        claimPendingPermissionCallback: vi.fn(async (input) => {
          const first =
            await firstRepository.claimPendingPermissionCallback(input);
          return (
            first ??
            (await secondRepository.claimPendingPermissionCallback(input))
          );
        }),
        releasePendingPermissionCallback: vi.fn(async (input) => {
          const first =
            await firstRepository.releasePendingPermissionCallback(input);
          return (
            first ||
            (await secondRepository.releasePendingPermissionCallback(input))
          );
        }),
        settlePendingPermissionCallback: vi.fn(async (input) => {
          const first =
            await firstRepository.settlePendingPermissionCallback(input);
          return (
            first ||
            (await secondRepository.settlePendingPermissionCallback(input))
          );
        }),
        resolvePendingInteraction: vi.fn(async (input) => {
          const first = await firstRepository.resolvePendingInteraction(input);
          return (
            first || (await secondRepository.resolvePendingInteraction(input))
          );
        }),
        findPendingPermissionPromptByMember: vi.fn(async (input) => {
          const first =
            await firstRepository.findPendingPermissionPromptByMember(input);
          return (
            first ??
            (await secondRepository.findPendingPermissionPromptByMember(input))
          );
        }),
      } as never,
    });

    await appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    )?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue({}),
      body: {
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.test/actions/agent-one',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: { value: JSON.stringify(firstValue) },
    });
    await expect(firstApproval).resolves.toMatchObject({ approved: true });
    let secondSettled = false;
    void secondApproval.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    await appRef.current.actionHandlers.get('gantry_perm_decision_cancel')?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue({}),
      body: {
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.test/actions/agent-two',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: { value: JSON.stringify(secondValue) },
    });
    await expect(secondApproval).resolves.toMatchObject({ approved: false });
  });

  it('posts Slack approval prompts ephemerally to approvers', async () => {
    defaultSlackPermissionApproverIds.add('U_APPROVER');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const approvalPromise = requestSlackPermissionApproval(channel, 'sl:C123', {
      requestId: 'perm-channel-prompt',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    });
    await flushSlackPromptRegistration();

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', user: 'U_APPROVER' }),
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision_allow_once',
    );
    const respond = vi.fn().mockResolvedValue({});
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.test/actions/private-prompt',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });
    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({ approved: true }),
    );
  });

  it('posts a visible Slack notice when no approver can receive a permission prompt', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook([]) as any,
    );
    await channel.connect();

    const approvalPromise = requestSlackPermissionApproval(channel, 'sl:C123', {
      requestId: 'perm-no-approver',
      sourceAgentFolder: 'slack_main',
      toolName: 'request_skill_install',
      title: 'Install skill for this agent',
    });
    await flushSlackPromptRegistration();

    await expect(approvalPromise).resolves.toMatchObject({ approved: false });
    expect(appRef.current.client.chat.postEphemeral).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        text: expect.stringContaining('no configured approvers'),
      }),
    );
  });

  it('fails closed when a Slack permission batch cannot be bound durably', async () => {
    vi.useFakeTimers();
    configurePendingInteractionDurability({
      repository: {
        bindPendingPermissionPrompt: vi.fn(async () => null),
      } as never,
    });
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const onPromptDelivered = vi.fn();
    const batch = createPermissionBatchRequest(
      [
        {
          requestId: 'perm-bind-1',
          sourceAgentFolder: 'slack_main',
          targetJid: 'sl:C123',
          toolName: 'Bash',
        },
        {
          requestId: 'perm-bind-2',
          sourceAgentFolder: 'slack_main',
          targetJid: 'sl:C123',
          toolName: 'Write',
        },
      ],
      ['1. Command', '2. File action'],
    );

    const approvalPromise = channel.requestPermissionApproval(
      'sl:C123',
      batch,
      onPromptDelivered,
    );
    await flushSlackPromptRegistration();
    await vi.runAllTimersAsync();

    await expect(approvalPromise).resolves.toMatchObject({ approved: false });
    expect(onPromptDelivered).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.postEphemeral).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clears a live Slack batch prompt when its post-send binding is already resolved', async () => {
    const requests = ['perm-bind-1', 'perm-bind-2'].map((requestId) => ({
      id: `pending-${requestId}`,
      appId: 'default',
      runId: 'run-1',
      kind: 'permission' as const,
      status: 'pending' as const,
      payload: {
        sourceAgentFolder: 'slack_main',
        requestId,
        request: {
          requestId,
          sourceAgentFolder: 'slack_main',
          targetJid: 'sl:C123',
          runId: 'run-1',
          toolName: 'Bash',
        },
      },
      callbackRoute: null,
      idempotencyKey: `default:permission:slack_main:${requestId}`,
      approverRef: null,
      resolution: null,
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2099-07-17T00:00:00.000Z',
      resolvedAt: null,
    }));
    const bindPendingPermissionPrompt = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(null);
    configurePendingInteractionDurability({
      repository: {
        bindPendingPermissionPrompt,
      } as never,
    });
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const onPromptDelivered = vi.fn();
    const batch = createPermissionBatchRequest(
      requests.map((entry) => ({
        requestId: String(entry.payload.requestId),
        sourceAgentFolder: 'slack_main',
        targetJid: 'sl:C123',
        runId: 'run-1',
        toolName: 'Bash',
      })),
      ['1. Command', '2. File action'],
    );

    await expect(
      channel.requestPermissionApproval('sl:C123', batch, onPromptDelivered),
    ).resolves.toMatchObject({ approved: false });

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledOnce();
    expect(bindPendingPermissionPrompt).toHaveBeenCalledTimes(2);
    expect(onPromptDelivered).not.toHaveBeenCalled();
    expect((channel as any).pendingPermissionPrompts.size).toBe(0);
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

    const approvalPromise = requestSlackPermissionApproval(
      channel,
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
    const respond = vi.fn().mockResolvedValue({});
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        channel: { id: 'C1234567890' },
        response_url: 'https://hooks.slack.test/actions/channel-allowlist',
        user: { id: 'U_ANY', name: 'Any User' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
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

  it('scopes Slack ephemeral permission prompts to this account approvers', async () => {
    const base = createOpts({ default: [], agents: {} });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', {
      ...base,
      runtimeSettings: vi.fn(() => {
        const settings = base.runtimeSettings();
        return {
          ...settings,
          providerAccounts: {
            ...settings.providerAccounts,
            slack_other: {
              ...settings.providerAccounts.slack_default,
              label: 'Slack Other',
            },
          },
          conversations: {
            other_account_conversation: {
              ...settings.conversations.slack_test_conversation,
              providerConnection: 'slack_other',
              controlApprovers: ['U_OTHER_ACCOUNT'],
            },
            this_account_conversation: {
              ...settings.conversations.slack_test_conversation,
              providerConnection: 'slack_default',
              controlApprovers: ['U_THIS_ACCOUNT'],
            },
          },
        };
      }),
    } as any);
    await channel.connect();

    const approvalPromise = requestSlackPermissionApproval(channel, 'sl:C123', {
      requestId: 'perm-provider-account-scope',
      sourceAgentFolder: 'slack_main',
      toolName: 'Bash',
    });
    await flushSlackPromptRegistration();

    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', user: 'U_THIS_ACCOUNT' }),
    );
    expect(appRef.current.client.chat.postEphemeral).not.toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U_OTHER_ACCOUNT' }),
    );
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();

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

    const approvalPromise = requestSlackPermissionApproval(
      channel,
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
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
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
      ...createOpts({ default: ['U_CHANNEL_ADMIN'], agents: {} }),
      isControlApproverAllowed,
    } as any);
    await channel.connect();

    const approvalPromise = requestSlackPermissionApproval(
      channel,
      'sl:C1234567890',
      {
        requestId: 'perm-channel-allowlist',
        sourceAgentFolder: 'slack_main',
        providerAccountId: 'slack_beta',
        decisionPolicy: 'same_channel',
        toolName: 'Bash',
      },
    );
    await flushSlackPromptRegistration();
    const actionsBlock =
      appRef.current.client.chat.postEphemeral.mock.calls[0]?.[0].blocks.find(
        (block: any) => block.type === 'actions',
      );
    expect(actionsBlock.elements[0].value).toContain(
      '"providerAccountId":"slack_beta"',
    );

    const actionHandler = appRef.current.actionHandlers.get(
      'gantry_perm_decision',
    );
    const respond = vi.fn().mockResolvedValue({});
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        channel: { id: 'C1234567890' },
        response_url: 'https://hooks.slack.test/actions/channel-allowlist',
        user: { id: 'U_CHANNEL_ADMIN', name: 'ChannelAdmin' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: true,
        decidedBy: 'U_CHANNEL_ADMIN',
      }),
    );
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'slack',
        providerAccountId: 'slack_beta',
        conversationJid: 'sl:C1234567890',
        userId: 'U_CHANNEL_ADMIN',
      }),
    );
  });

  it('authorizes Slack same-channel decisions from block action container channel', async () => {
    const isControlApproverAllowed = vi.fn(async () => true);
    const channel = new SlackChannel('xoxb-token', 'xapp-token', {
      ...createOpts({ default: ['U_CHANNEL_ADMIN'], agents: {} }),
      isControlApproverAllowed,
    } as any);
    await channel.connect();

    const approvalPromise = requestSlackPermissionApproval(
      channel,
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
    const respond = vi.fn().mockResolvedValue({});
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        container: { channel_id: 'C1234567890' },
        response_url: 'https://hooks.slack.test/actions/container-channel',
        user: { id: 'U_CHANNEL_ADMIN', name: 'ChannelAdmin' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });

    await expect(approvalPromise).resolves.toEqual(
      expect.objectContaining({
        approved: true,
        decidedBy: 'U_CHANNEL_ADMIN',
      }),
    );
    expect(isControlApproverAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'slack',
        conversationJid: 'sl:C1234567890',
        userId: 'U_CHANNEL_ADMIN',
      }),
    );
    expect(appRef.current.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U_CHANNEL_ADMIN' }),
    );
  });

  it('fails closed when Slack same-channel callbacks omit channel context', async () => {
    const isControlApproverAllowed = vi.fn(async () => true);
    const channel = new SlackChannel('xoxb-token', 'xapp-token', {
      ...createOpts({ default: ['U_CHANNEL_ADMIN'], agents: {} }),
      isControlApproverAllowed,
    } as any);
    await channel.connect();

    const approvalPromise = requestSlackPermissionApproval(
      channel,
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
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
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
        default: ['U_OTHER'],
        agents: {
          agent_one: ['U_APPROVER'],
          agent_two: ['U_OTHER'],
        },
      }) as any,
    );
    await channel.connect();

    const approvalPromise = requestSlackPermissionApproval(
      channel,
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
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
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

    const approvalPromise = requestSlackPermissionApproval(
      channel,
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
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
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

    const answerPromise = requestSlackUserAnswer(channel, 'sl:C1234567890', {
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
    const actionBlock = (postCall?.blocks as any[])?.find(
      (block) => block.type === 'actions',
    );
    const actionIds = actionBlock?.elements?.map(
      (element: any) => element.action_id,
    );
    expect(new Set(actionIds).size).toBe(actionIds?.length);
    expect(actionIds).toEqual([
      'gantry_userq_select_0',
      'gantry_userq_select_1',
      'gantry_userq_other',
    ]);

    const actionHandler = slackActionHandler('gantry_userq_select_1');
    expect(actionHandler).toBeTypeOf('function');
    const ack = vi.fn().mockResolvedValue(undefined);
    await actionHandler?.({
      ack,
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U123', name: 'Alice' },
      },
      action: {
        value: JSON.stringify(
          latestSlackUserQuestionActionValue('gantry_userq_select', 1),
        ),
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

    const answerPromise = requestSlackUserAnswer(channel, 'sl:C1234567890', {
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
        value: JSON.stringify(
          latestSlackUserQuestionActionValue('gantry_userq_other'),
        ),
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

    const answerPromise = requestSlackUserAnswer(channel, 'sl:C1234567890', {
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

    const actionHandler = slackActionHandler('gantry_userq_select_1');
    expect(actionHandler).toBeTypeOf('function');

    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U_OTHER', name: 'Not Allowed' },
      },
      action: {
        value: JSON.stringify(
          latestSlackUserQuestionActionValue('gantry_userq_select', 1),
        ),
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
        value: JSON.stringify(
          latestSlackUserQuestionActionValue('gantry_userq_select', 0),
        ),
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

    const answerPromise = requestSlackUserAnswer(channel, 'sl:C1234567890', {
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

    const selectHandler = slackActionHandler('gantry_userq_select_0');
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
        value: JSON.stringify(
          latestSlackUserQuestionActionValue('gantry_userq_select', 0),
        ),
      },
    });
    await selectHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U123', name: 'Alice' },
      },
      action: {
        value: JSON.stringify(
          latestSlackUserQuestionActionValue('gantry_userq_select', 2),
        ),
      },
    });
    await doneHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        channel: { id: 'C1234567890' },
        user: { id: 'U123', name: 'Alice' },
      },
      action: {
        value: JSON.stringify(
          latestSlackUserQuestionActionValue('gantry_userq_done'),
        ),
      },
    });

    const answer = await answerPromise;
    expect(answer.answers).toEqual({ 'Select options': ['Alpha', 'Gamma'] });
    expect(answer.answeredBy).toBe('Alice');
  });

  it('propagates Slack post-send permission persistence failure and retains the waiter', async () => {
    defaultSlackPermissionApproverIds.add('U_APPROVER');
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const request = {
      requestId: 'perm-post-send-persist-failure',
      sourceAgentFolder: 'slack_main',
      targetJid: 'sl:C123',
      toolName: 'Bash',
    };
    const repository = configureSlackPermissionRequest(request);
    const persist = repository.bindPendingPermissionPrompt;
    const original = persist.getMockImplementation()!;
    let calls = 0;
    persist.mockImplementation(async (input) => {
      calls += 1;
      if (calls === 2) throw new Error('write failed');
      return await original(input);
    });

    await expect(
      channel.requestPermissionApproval('sl:C123', request),
    ).rejects.toMatchObject({ name: 'DurableInteractionPersistenceError' });
    expect((channel as any).pendingPermissionPrompts.size).toBe(1);
    for (const pending of (channel as any).pendingPermissionPrompts.values()) {
      clearTimeout(pending.timer);
    }
    (channel as any).pendingPermissionPrompts.clear();
  });

  it('returns empty Slack user-question answers when prompt times out', async () => {
    vi.useFakeTimers();
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const answerPromise = requestSlackUserAnswer(channel, 'sl:C1234567890', {
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
    expect(
      answerPromise.interaction.payload.questionRecoveryEnvelope,
    ).toMatchObject({
      completedQuestionIndexes: [0],
    });
    vi.useRealTimers();
  });

  it('cleans up pending Slack user-question prompts on disconnect', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    const answerPromise = requestSlackUserAnswer(channel, 'sl:C1234567890', {
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

  it('does not let a reset partial fallback seal the replacement Slack stream', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();

    let startCount = 0;
    let oldAppendCount = 0;
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string, payload: Record<string, unknown>) => {
        if (method === 'chat.startStream') {
          startCount += 1;
          return {
            ok: true,
            stream_ts:
              startCount === 1 ? 'old-stream-ts' : 'replacement-stream-ts',
          };
        }
        if (method === 'chat.appendStream') {
          if (payload.ts === 'old-stream-ts') {
            oldAppendCount += 1;
            return oldAppendCount === 1
              ? { ok: true }
              : { ok: false, error: 'append_failed' };
          }
          return { ok: true };
        }
        if (method === 'chat.stopStream') return { ok: true };
        return { ok: false };
      },
    );
    let resolveFallback: ((value: { ok: boolean; ts: string }) => void) | null =
      null;
    vi.mocked(appRef.current.client.chat.postMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFallback = resolve;
        }),
    );
    const jid = 'sl:C1234567890';
    const threadId = '1710000000.111222';
    await channel.sendStreamingChunk(jid, 'seed', {
      threadId,
      generation: 3,
    });

    const oldFinal = channel.sendStreamingChunk(jid, 'x'.repeat(13050), {
      threadId,
      generation: 3,
      done: true,
    });
    await vi.waitFor(() =>
      expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1),
    );
    channel.resetStreaming(jid, { threadId });
    await channel.sendStreamingChunk(jid, 'new', {
      threadId,
      generation: 3,
    });

    resolveFallback?.({ ok: true, ts: 'fallback-message-ts' });
    await oldFinal;
    await channel.sendStreamingChunk(jid, ' tail', {
      threadId,
      generation: 3,
      done: true,
    });

    expect(appRef.current.client.apiCall).toHaveBeenCalledWith(
      'chat.appendStream',
      expect.objectContaining({
        ts: 'replacement-stream-ts',
        markdown_text: ' tail',
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

  it('stops Slack fallback parts when the stream epoch changes mid-send', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall).mockResolvedValue({ ok: false });
    let resolveFirst!: (value: { ok: boolean; ts: string }) => void;
    vi.mocked(appRef.current.client.chat.postMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const jid = 'sl:C1234567890';
    const threadId = '1710000000.111222';

    const delivery = channel.sendStreamingChunk(jid, 'x'.repeat(4500), {
      done: true,
      generation: 1,
      threadId,
    });
    await vi.waitFor(() =>
      expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1),
    );
    channel.resetStreaming(jid, { threadId });
    resolveFirst({ ok: true, ts: 'first-fallback-ts' });
    await delivery;

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1);
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

  it('skips Slack snippet fallback when a targeted reset lands during native failure', async () => {
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
          fallbackArtifactId: 'slack-stream-artifact-reset',
          externalMessageId: '1710000000.889000',
        };
      }
    }
    const channel = new SlackChannelWithStreamSnippetFallback(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();
    let resolveAppend!: (value: { ok: boolean; error: string }) => void;
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: 'reset-native-stream' };
        }
        if (method === 'chat.appendStream') {
          return new Promise((resolve) => {
            resolveAppend = resolve;
          });
        }
        if (method === 'chat.stopStream') return { ok: true };
        return { ok: false };
      },
    );
    const jid = 'sl:C1234567890';
    const threadId = '1710000000.111222';
    await channel.sendStreamingChunk(jid, 'seed', { threadId });

    const delivery = channel.sendStreamingChunk(jid, 'x'.repeat(20_000), {
      done: true,
      threadId,
    });
    await vi.waitFor(() => expect(resolveAppend).toBeTypeOf('function'));
    channel.resetStreaming(jid, { threadId });
    resolveAppend({ ok: false, error: 'append failed' });

    await expect(delivery).resolves.toBe(false);
    expect(channel.fallbackCalls).toEqual([]);
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('skips catch-path Slack snippet fallback when reset lands during a partial native failure', async () => {
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
          fallbackArtifactId: 'slack-stream-artifact-partial-reset',
          externalMessageId: '1710000000.889001',
        };
      }
    }
    const channel = new SlackChannelWithStreamSnippetFallback(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();
    let appendCount = 0;
    let resolveSecondAppend!: (value: { ok: boolean; error: string }) => void;
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: 'reset-partial-native-stream' };
        }
        if (method === 'chat.appendStream') {
          appendCount += 1;
          if (appendCount === 1) return { ok: true };
          return new Promise((resolve) => {
            resolveSecondAppend = resolve;
          });
        }
        if (method === 'chat.stopStream') return { ok: true };
        return { ok: false };
      },
    );
    const jid = 'sl:C1234567890';
    const threadId = '1710000000.111223';
    await channel.sendStreamingChunk(jid, 'seed', { threadId });

    const delivery = channel.sendStreamingChunk(jid, 'x'.repeat(40_000), {
      done: true,
      threadId,
    });
    await vi.waitFor(() => expect(resolveSecondAppend).toBeTypeOf('function'));
    channel.resetStreaming(jid, { threadId });
    resolveSecondAppend({ ok: false, error: 'append failed' });

    await expect(delivery).resolves.toBe(false);
    expect(channel.fallbackCalls).toEqual([]);
    expect(appRef.current.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('does not accept a Slack snippet fallback that finishes after a targeted reset', async () => {
    class SlackChannelWithDeferredSnippetFallback extends SlackChannel {
      fallbackCalls: Array<Record<string, unknown>> = [];
      resolveFallback!: (value: {
        fallbackArtifactId: string;
        externalMessageId: string;
      }) => void;

      protected override async sendSnippetFallback(input: {
        channelId: string;
        text: string;
        threadId?: string;
        reason: string;
      }) {
        this.fallbackCalls.push(input);
        return new Promise<{
          fallbackArtifactId: string;
          externalMessageId: string;
        }>((resolve) => {
          this.resolveFallback = resolve;
        });
      }
    }
    const channel = new SlackChannelWithDeferredSnippetFallback(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          return { ok: true, stream_ts: 'deferred-snippet-native-stream' };
        }
        if (method === 'chat.appendStream') {
          return { ok: false, error: 'append failed' };
        }
        if (method === 'chat.stopStream') return { ok: true };
        return { ok: false };
      },
    );
    const jid = 'sl:C1234567890';
    const threadId = '1710000000.111224';
    await channel.sendStreamingChunk(jid, 'seed', { threadId });

    const delivery = channel.sendStreamingChunk(jid, 'x'.repeat(20_000), {
      done: true,
      threadId,
    });
    await vi.waitFor(() => expect(channel.fallbackCalls).toHaveLength(1));
    channel.resetStreaming(jid, { threadId });
    channel.resolveFallback({
      fallbackArtifactId: 'slack-stream-artifact-after-reset',
      externalMessageId: '1710000000.889002',
    });

    await expect(delivery).resolves.toBe(false);
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

  it('does not restore a targeted Slack stream after an in-flight send', async () => {
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOpts() as any,
    );
    await channel.connect();
    let resolveFirstStart!: (result: {
      ok: boolean;
      stream_ts: string;
    }) => void;
    const firstStart = new Promise<{ ok: boolean; stream_ts: string }>(
      (resolve) => {
        resolveFirstStart = resolve;
      },
    );
    let startCount = 0;
    vi.mocked(appRef.current.client.apiCall).mockImplementation(
      async (method: string) => {
        if (method === 'chat.startStream') {
          startCount += 1;
          return startCount === 1
            ? firstStart
            : { ok: true, stream_ts: '1710000000.444555' };
        }
        if (method === 'chat.appendStream' || method === 'chat.stopStream') {
          return { ok: true };
        }
        return { ok: false };
      },
    );

    const inFlight = channel.sendStreamingChunk('sl:C1234567890', 'old', {
      threadId: '1710000000.111222',
    });
    await vi.waitFor(() => expect(startCount).toBe(1));
    channel.resetStreaming('sl:C1234567890', {
      threadId: '1710000000.111222',
    });
    resolveFirstStart({ ok: true, stream_ts: '1710000000.222333' });
    await inFlight;

    expect(vi.mocked(appRef.current.client.apiCall)).toHaveBeenCalledWith(
      'chat.stopStream',
      { channel: 'C1234567890', ts: '1710000000.222333' },
    );

    await channel.sendStreamingChunk('sl:C1234567890', 'new', {
      threadId: '1710000000.111222',
    });

    expect(
      vi
        .mocked(appRef.current.client.apiCall)
        .mock.calls.filter(([method]) => method === 'chat.startStream'),
    ).toEqual([
      ['chat.startStream', expect.objectContaining({ markdown_text: 'old' })],
      ['chat.startStream', expect.objectContaining({ markdown_text: 'new' })],
    ]);
  });

  it('resolves an ephemeral Slack permission prompt on timeout without message mutation', async () => {
    vi.useFakeTimers();
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();

    const decisionPromise = requestSlackPermissionApproval(
      channel,
      'sl:C1234567890',
      {
        requestId: 'req-timeout',
        sourceAgentFolder: 'test',
        toolName: 'shell',
      },
    );
    await flushSlackPromptRegistration();

    await vi.advanceTimersByTimeAsync(300000);
    await expect(decisionPromise).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'timed out',
    });
    expect(appRef.current.client.chat.update).not.toHaveBeenCalled();
    expect(appRef.current.client.chat.delete).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('resolves the Slack waiter after retryable timeout claims exhaust bounded retries', async () => {
    vi.useFakeTimers();
    const channel = new SlackChannel(
      'xoxb-token',
      'xapp-token',
      createOptsWithApproverHook(['U_APPROVER']) as any,
    );
    await channel.connect();
    const request = {
      requestId: 'req-timeout-retryable',
      sourceAgentFolder: 'test',
      toolName: 'shell',
    };
    const repository = configureSlackPermissionRequest(request);
    repository.claimPendingPermissionCallback.mockRejectedValue(
      new Error('postgres unavailable'),
    );

    const decisionPromise = channel.requestPermissionApproval(
      'sl:C1234567890',
      request,
    );
    await flushSlackPromptRegistration();
    await vi.advanceTimersByTimeAsync(600_000);

    await expect(decisionPromise).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'timed out',
    });
    expect(repository.claimPendingPermissionCallback).toHaveBeenCalledTimes(3);
    expect((channel as any).pendingPermissionPrompts.size).toBe(0);
    vi.useRealTimers();
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

    const decisionPromise = requestSlackPermissionApproval(
      channel,
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
    const respond = vi.fn().mockResolvedValue({});
    await actionHandler?.({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        response_url: 'https://hooks.slack.test/actions/req-1',
        user: { id: 'U_APPROVER', name: 'Approver' },
      },
      action: {
        value: JSON.stringify(
          latestSlackPermissionActionValue('gantry_perm_decision_allow_once'),
        ),
      },
    });

    const decision = await decisionPromise;
    expect(decision).toEqual(
      expect.objectContaining({ approved: true, decidedBy: 'U_APPROVER' }),
    );
    expect(respond).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300000);
    expect(respond).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
