import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Telegram's Bot API is the only fake: each bot records what it sends and the
// update handlers the channel registers, so a test can tap a button the way
// Telegram delivers it.
type InlineButton = { text: string; callback_data: string };
type SentMessage = {
  chatId: string;
  messageId: number;
  text: string;
  buttons: InlineButton[];
};
const telegram = vi.hoisted(() => ({
  sent: [] as SentMessage[],
  handlers: new Map<string, Array<(ctx: unknown) => Promise<void>>>(),
}));
vi.mock('grammy', () => ({
  InputFile: class {},
  Bot: class {
    api = new Proxy(
      {
        config: { use: () => undefined },
        sendMessage: async (
          chatId: string | number,
          text: string,
          options?: {
            reply_markup?: { inline_keyboard?: InlineButton[][] };
          },
        ) => {
          const messageId = 500 + telegram.sent.length;
          telegram.sent.push({
            chatId: String(chatId),
            messageId,
            text,
            buttons: options?.reply_markup?.inline_keyboard?.flat() ?? [],
          });
          return { message_id: messageId };
        },
      } as Record<string, unknown>,
      {
        get: (target, name: string) =>
          name in target ? target[name] : async () => true,
      },
    );
    on(filter: string, handler: (ctx: unknown) => Promise<void>) {
      telegram.handlers.set(filter, [
        ...(telegram.handlers.get(filter) ?? []),
        handler,
      ]);
    }
    command() {}
    catch() {}
    use() {}
    start(opts?: { onStart?: (info: unknown) => void }) {
      opts?.onStart?.({ username: 'gantry_bot', id: 1 });
    }
    stop() {}
    isRunning() {
      return true;
    }
  },
}));

import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import {
  configurePendingInteractionDurability,
  configurePendingInteractionPermissionPersistence,
} from '@core/application/interactions/pending-interaction-durability.js';
import { asPermissionApprovalSurface } from '@core/app/bootstrap/channel-capability-ports.js';
import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
import { TelegramChannel } from '@core/channels/telegram/channel-adapter.js';
import { findChannel } from '@core/messaging/router.js';
import { GANTRY_HOME, RUNTIME_SETTINGS_PATH } from '@core/config/index.js';
import type { NewMessage } from '@core/domain/types.js';
import { processTaskIpc } from '@core/jobs/ipc-handler.js';
import { formatConversationContextMessages } from '@core/messaging/router.js';
import { buildBaseRunnerEnv } from '@core/runtime/agent-spawn-helpers.js';
import { taskIpcResponsePath } from '@core/jobs/ipc-shared.js';
import { createAgentToolRuleSettingsMirror } from '@core/config/settings/agent-tool-rule-settings-mirror.js';
import {
  ensureConfiguredAgent,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import { processPermissionInteractionIpc } from '@core/runtime/ipc-interaction-processing.js';
import { parsePermissionIpcRequest } from '@core/runtime/ipc-parsing.js';
import { parseTaskIpcData } from '@core/runtime/ipc-task-parsing.js';
import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';
import { requestPermissionApprovalViaIpc } from '@core/runner/permission-ipc-client.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const APP_ID = 'default';
const AGENT_ID = 'agent:main_agent';
const AGENT_FOLDER = 'main_agent';
const TARGET_JID = 'tg:100200300';
const PROVIDER_ACCOUNT = 'telegram_prompt_shape';
const APPROVER_USER_ID = 222;

// Real asks end to end: the runner's signed IPC request, the host processor
// over Postgres, the channel approval requester, the Telegram channel's card
// and its own callback handler for the tap. Only Telegram's Bot API is faked.
maybeDescribe('permission-prompt-shape', () => {
  let runtime: PostgresIntegrationRuntime;
  let ipcBaseDir: string;
  let originalSettingsYaml: string;
  let originalDatabaseUrl: string | undefined;
  let runnerControl: FilesystemRunnerControlPort;
  let ipcAuth: ReturnType<typeof createIpcAuthEnvelope>;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'perm_prompt_shape',
    });
    originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    process.env.GANTRY_DATABASE_URL = process.env.GANTRY_TEST_DATABASE_URL;
    process.env.SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    originalSettingsYaml = fs.readFileSync(RUNTIME_SETTINGS_PATH, 'utf-8');
    const settings = loadRuntimeSettings(GANTRY_HOME);
    ensureConfiguredAgent(settings, {
      agentId: AGENT_FOLDER,
      agentName: 'Main Agent',
      agentFolder: AGENT_FOLDER,
    });
    saveRuntimeSettings(GANTRY_HOME, settings);
    configurePendingInteractionDurability({
      repository: runtime.repositories.workerCoordination,
    });
    configurePendingInteractionPermissionPersistence({
      opsRepository: runtime.ops,
      getToolRepository: () => runtime.repositories.tools,
      getPermissionRepository: () => runtime.repositories.permissions,
      mirrorAgentToolRulesToSettings: createAgentToolRuleSettingsMirror({
        opsRepository: runtime.ops,
        repositories: runtime.repositories,
        reloadRuntimeState: async () => {},
        leases: { tryAcquire: async () => ({ release: async () => {} }) },
      }),
    });
    ipcBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-prompt-shape-'));
    runnerControl = new FilesystemRunnerControlPort(ipcBaseDir);
    runnerControl.ensureRoot();
    runnerControl.ensureWorkspaceLayout(AGENT_FOLDER);
    ipcAuth = createIpcAuthEnvelope(AGENT_FOLDER, undefined, {
      appId: APP_ID,
      agentId: AGENT_ID,
    });
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('exercise the production polling fallback');
    });
  }, 60_000);

  afterAll(async () => {
    configurePendingInteractionDurability(null);
    configurePendingInteractionPermissionPersistence(null);
    if (originalSettingsYaml !== undefined) {
      fs.writeFileSync(RUNTIME_SETTINGS_PATH, originalSettingsYaml, 'utf-8');
    }
    if (originalDatabaseUrl === undefined)
      delete process.env.GANTRY_DATABASE_URL;
    else process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
    if (runtime) await runtime.cleanup();
    if (ipcBaseDir) fs.rmSync(ipcBaseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function waitForPermissionRequest(): Promise<string> {
    const requestDir = path.join(
      ipcBaseDir,
      AGENT_FOLDER,
      'permission-requests',
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const file = fs.existsSync(requestDir)
        ? fs.readdirSync(requestDir).find((entry) => entry.endsWith('.json'))
        : undefined;
      if (file) return path.join(requestDir, file);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for the signed permission request');
  }

  /** A connected Telegram channel for the chat, approved by one person. */
  async function connectTelegram() {
    // Telegram delivers a tap only to the bot that sent the card.
    telegram.handlers.clear();
    const channel = new TelegramChannel('test-token', {
      appId: APP_ID,
      providerAccountId: PROVIDER_ACCOUNT,
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      conversationRoutes: () => ({
        [TARGET_JID]: {
          name: 'Ops',
          folder: AGENT_FOLDER,
          trigger: '@Main',
          added_at: '2026-10-02T00:00:00.000Z',
          providerAccountId: PROVIDER_ACCOUNT,
        },
      }),
      runtimeSettings: () =>
        ({
          providers: { telegram: { enabled: true } },
          providerAccounts: {
            [PROVIDER_ACCOUNT]: {
              provider: 'telegram',
              agentId: AGENT_FOLDER,
              label: 'Telegram',
              runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
            },
          },
          conversations: {
            ops: {
              providerAccount: PROVIDER_ACCOUNT,
              externalId: TARGET_JID.replace(/^tg:/, ''),
              kind: 'group',
              displayName: 'Ops',
              controlApprovers: [String(APPROVER_USER_ID)],
            },
          },
          bindings: {
            ops: { agent: AGENT_FOLDER, conversation: 'ops', trigger: '@Main' },
          },
        }) as never,
    } as never);
    await channel.connect();
    const requester = createPermissionApprovalRequester({
      findBoundChannel: (jid) => findChannel([channel], jid),
      asPermissionApprovalSurface: (bound) =>
        asPermissionApprovalSurface(bound as never),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    return { channel, requester };
  }

  /** The permission card Telegram received, once its prompt is bound. */
  async function nextPermissionCard(after: number): Promise<SentMessage> {
    let card: SentMessage | undefined;
    await vi.waitFor(
      async () => {
        card = telegram.sent
          .slice(after)
          .find((message) => message.buttons.length > 0);
        expect(card).toBeDefined();
        const [prompt] = await runtime.service.db
          .select()
          .from(pgSchema.permissionPromptsPostgres)
          .where(
            eq(
              pgSchema.permissionPromptsPostgres.externalPromptMessageId,
              String(card!.messageId),
            ),
          );
        expect(prompt).toBeDefined();
      },
      { timeout: 10_000 },
    );
    return card!;
  }

  /** The approver taps `label`, delivered the way Telegram delivers it. */
  async function tap(card: SentMessage, label: string): Promise<string[]> {
    const button = card.buttons.find((candidate) => candidate.text === label);
    expect(button).toBeDefined();
    const answers: string[] = [];
    const update = {
      callbackQuery: {
        id: `callback-${card.messageId}`,
        data: button!.callback_data,
        message: {
          chat: { id: Number(card.chatId) },
          message_id: card.messageId,
        },
      },
      chat: { id: Number(card.chatId) },
      from: { id: APPROVER_USER_ID, first_name: 'Ravi' },
      answerCallbackQuery: async (answer?: { text?: string }) => {
        answers.push(answer?.text ?? '');
        return true;
      },
      editMessageText: async () => true,
      editMessageReplyMarkup: async () => true,
    };
    for (const handler of telegram.handlers.get('callback_query:data') ?? []) {
      await handler(update);
    }
    return answers;
  }

  it('asks with what, which and why and the Allow once, Allow for future and Deny buttons, and a Deny tap denies the call', async () => {
    const { requester } = await connectTelegram();
    const sentBefore = telegram.sent.length;
    const decision = requestPermissionApprovalViaIpc(
      {
        appId: APP_ID,
        agentId: AGENT_ID,
        chatJid: TARGET_JID,
        jobId: '',
        jobName: '',
        jobRunId: '',
        jobRunLeaseToken: '',
        jobRunLeaseFencingVersion: '',
        ipcAuthToken: ipcAuth.authToken,
        ipcResponseVerifyKey: ipcAuth.responseVerifyKey,
        ipcResponseKeyId: ipcAuth.responseKeyId,
        permissionRequestTimeoutMs: 0,
        permissionLane: 'interactive',
        turnIntentSummary:
          '<context timezone="UTC" />\n<messages>\n<message sender="Ravi" time="09:00">List my five newest repos for the weekly note</message>\n</messages>',
        resolveWorkspaceIpcDir: (folder) => path.join(ipcBaseDir, folder),
      },
      {
        agentFolder: AGENT_FOLDER,
        toolName: 'Bash',
        toolInput: { command: 'gh repo list --limit 5' },
      },
    );

    const requestPath = await waitForPermissionRequest();
    const claimed = runnerControl.claimRequest(
      AGENT_FOLDER,
      'permission-requests',
      path.basename(requestPath),
    );
    const request = parsePermissionIpcRequest(
      claimed.raw as Record<string, unknown>,
      AGENT_FOLDER,
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps: IpcDeps = {
      sendMessage: vi.fn(async () => undefined),
      conversationRoutes: () => ({}),
      registerGroup: async () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: async () => undefined,
      onSchedulerChanged: () => undefined,
      requestPermissionApproval: requester,
      requestUserAnswer: async () => ({ answers: {} }),
      opsRepository: runtime.ops,
      getToolRepository: () => runtime.repositories.tools,
      getPermissionRepository: () => runtime.repositories.permissions,
      publishRuntimeEvent: (event) =>
        runtime.storageRuntime.runtimeEvents
          .publish(event)
          .then(() => undefined),
    };
    const processing = processPermissionInteractionIpc({
      request,
      sourceAgentFolder: AGENT_FOLDER,
      deps,
      ipcBaseDir,
      file: path.basename(requestPath),
      claimedPath: claimed.claimedPath,
      logger,
    });

    const card = await nextPermissionCard(sentBefore);
    expect(card.text).toContain(
      'Allow Main Agent to use exact command access?',
    );
    expect(card.text).toContain('Runs: gh');
    expect(card.text).toContain(
      'Why: List my five newest repos for the weekly note',
    );
    expect(card.buttons.map((button) => button.text)).toEqual([
      'Allow once',
      'Allow for future',
      'Deny',
    ]);
    await tap(card, 'Deny');
    await processing;
    await expect(decision).resolves.toMatchObject({
      approved: false,
      mode: 'cancel',
    });
    const [row] = await runtime.service.db
      .select()
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        eq(pgSchema.pendingInteractionsPostgres.requestId, request.requestId),
      );
    expect(row?.status).toBe('cancelled');
  }, 60_000);

  it('asks for a skill install with why from the turn, secrets hidden, and only Allow once and Deny, and a Deny tap installs nothing and says how to try again', async () => {
    const password = 'hunter2-secret-pass';
    const source = `https://ravi:${password}@git.example.com/acme/weather`;
    // A chat turn whose earlier conversation fills far more than the
    // 1,500 characters the runner's environment carries.
    const message = (id: string, content: string): NewMessage => ({
      id,
      chat_jid: TARGET_JID,
      sender: 'user:ravi',
      sender_name: 'Ravi',
      content,
      timestamp: '2026-10-02T09:00:00.000Z',
    });
    const turnPrompt = formatConversationContextMessages(
      {
        recentChannelContext: Array.from({ length: 12 }, (_, index) =>
          message(`history-${index}`, `Earlier chat line ${index} `.repeat(20)),
        ),
        activeThreadContext: [],
        currentMessages: [
          message(
            'current',
            `Install the weather skill from ${source} for the weekly note`,
          ),
        ],
      },
      'UTC',
    );
    expect(turnPrompt.length).toBeGreaterThan(3_000);
    const runnerEnv = buildBaseRunnerEnv({
      hostEnv: {},
      preparedEnv: {},
      runnerToolProcessEnv: {},
      timezone: 'UTC',
      mcpServerPath: '',
      hostRuntimeGroupDir: '',
      workspaceKey: AGENT_FOLDER,
      runnerAppId: APP_ID,
      agentId: AGENT_ID,
      processName: 'prompt-shape',
      workspaceExtraDir: '',
      workspaceIpcDir: path.join(ipcBaseDir, AGENT_FOLDER),
      ipcInputDir: '',
      ipcAuthToken: ipcAuth.authToken,
      chatJid: TARGET_JID,
      runnerModel: 'model',
      memoryIpcAuthToken: '',
      memoryIpcAllowedActions: [],
      responseVerifyKey: ipcAuth.responseVerifyKey,
      responseKeyId: ipcAuth.responseKeyId,
      hideAuthorityTools: false,
      agentAccessPreset: 'full',
      deploymentMode: 'workstation',
      permissionMode: 'ask',
      permissionLane: 'interactive',
      turnIntentSummary: turnPrompt,
      permissionTimeoutMs: 0,
      egressProxyUrl: '',
      sandboxRuntimeProxy: false,
      deepAgentsShellEnv: {},
      deepAgentsFilesystemEnv: {},
      pickSafeHostEnv: () => ({}),
      pickPreparedExecutionEnv: () => ({}),
    });
    // The agent's Gantry tool server, started for this turn.
    vi.stubEnv('GANTRY_IPC_DIR', path.join(ipcBaseDir, AGENT_FOLDER));
    vi.stubEnv('GANTRY_IPC_AUTH_TOKEN', ipcAuth.authToken);
    vi.stubEnv('GANTRY_IPC_RESPONSE_KEY_ID', ipcAuth.responseKeyId);
    vi.stubEnv('GANTRY_IPC_RESPONSE_VERIFY_KEY', ipcAuth.responseVerifyKey);
    vi.stubEnv('GANTRY_APP_ID', APP_ID);
    vi.stubEnv('GANTRY_AGENT_ID', AGENT_ID);
    vi.stubEnv('GANTRY_CHAT_JID', TARGET_JID);
    vi.stubEnv('GANTRY_WORKSPACE_KEY', AGENT_FOLDER);
    vi.stubEnv('GANTRY_PERMISSION_LANE', 'interactive');
    vi.stubEnv(
      'GANTRY_TURN_INTENT_SUMMARY',
      runnerEnv.GANTRY_TURN_INTENT_SUMMARY,
    );
    const { writeIpcFile } = await import('@core/runner/mcp/ipc.js');
    const { TASKS_DIR } = await import('@core/runner/mcp/context.js');
    const file = writeIpcFile(TASKS_DIR, {
      type: 'request_skill_install',
      taskId: 'skill-install-prompt-shape',
      targetJid: TARGET_JID,
      chatJid: TARGET_JID,
      payload: {
        expectedFiles: [],
        dependencies: [],
        requiredEnvVars: [],
        files: [],
        installCommandArgv: ['npx', 'skills', 'add', source],
        reason: 'Weather lookups for the weekly note',
      },
      timestamp: new Date().toISOString(),
    });
    vi.unstubAllEnvs();

    const { requester } = await connectTelegram();
    const sentBefore = telegram.sent.length;
    const runApprovedCommand = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    const claimed = runnerControl.claimRequest(AGENT_FOLDER, 'tasks', file);
    await processTaskIpc(
      parseTaskIpcData(claimed.raw, AGENT_FOLDER),
      AGENT_FOLDER,
      {
        sendMessage,
        conversationRoutes: () => ({ [TARGET_JID]: { folder: AGENT_FOLDER } }),
        registerGroup: async () => undefined,
        syncGroups: async () => undefined,
        getAvailableGroups: () => [],
        writeGroupsSnapshot: async () => undefined,
        onSchedulerChanged: () => undefined,
        requestPermissionApproval: requester,
        requestUserAnswer: async () => ({ answers: {} }),
        runApprovedCommand,
        opsRepository: runtime.ops,
      } as IpcDeps,
      ipcBaseDir,
    );

    const card = await nextPermissionCard(sentBefore);
    expect(card.text).toContain('Install: npx skills add https://');
    expect(card.text).toContain('Why: Install the weather skill from https://');
    expect(card.text).not.toContain(password);
    expect(card.buttons.map((button) => button.text)).toEqual([
      'Allow once',
      'Deny',
    ]);
    await tap(card, 'Deny');
    // The agent's tool call gets the denial back.
    const responsePath = taskIpcResponsePath(
      AGENT_FOLDER,
      'skill-install-prompt-shape',
    );
    await vi.waitFor(() => expect(fs.existsSync(responsePath)).toBe(true), {
      timeout: 10_000,
    });
    expect(JSON.parse(fs.readFileSync(responsePath, 'utf-8'))).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
    // What the person sees says what happened and what to do next.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(TARGET_JID);
    expect(sendMessage.mock.calls[0]?.[1]).toMatch(
      /^Did not install skill .+: canceled via Telegram\. To try again, ask me again and an approver can allow it\.$/,
    );
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain(password);
    const rows = await runtime.service.db
      .select()
      .from(pgSchema.pendingInteractionsPostgres)
      .where(
        eq(
          pgSchema.pendingInteractionsPostgres.sourceAgentFolder,
          AGENT_FOLDER,
        ),
      );
    const stored = rows.find(
      (row) =>
        (row.payloadJson as { toolName?: string }).toolName ===
        'request_skill_install',
    );
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored?.payloadJson)).not.toContain(password);
    expect(runApprovedCommand).not.toHaveBeenCalled();
  }, 60_000);
});
