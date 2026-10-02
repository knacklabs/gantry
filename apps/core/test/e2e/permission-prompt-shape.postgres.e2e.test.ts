import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import {
  bindPendingPermissionInteractionMessage,
  claimPermissionInteractionCallback,
  configurePendingInteractionDurability,
  configurePendingInteractionPermissionPersistence,
} from '@core/application/interactions/pending-interaction-durability.js';
import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
import { permissionDecisionOptions } from '@core/channels/permission-card-affordances.js';
import { decisionForMode } from '@core/channels/permission-interaction.js';
import { parseTelegramPermissionCallbackData } from '@core/channels/telegram/channel-shared.js';
import { prepareTelegramPermissionCardSend } from '@core/channels/telegram/prepared-permission-card.js';
import { GANTRY_HOME, RUNTIME_SETTINGS_PATH } from '@core/config/index.js';
import { createAgentToolRuleSettingsMirror } from '@core/config/settings/agent-tool-rule-settings-mirror.js';
import {
  ensureConfiguredAgent,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalResult,
} from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import { processPermissionInteractionIpc } from '@core/runtime/ipc-interaction-processing.js';
import { parsePermissionIpcRequest } from '@core/runtime/ipc-parsing.js';
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
const APPROVER = 'user:prompt-shape';

type InlineButton = { text: string; callback_data: string };

// One real ask end to end: the runner's signed permission IPC request, the
// host IPC processor over Postgres, the channel approval requester, the
// Telegram permission card renderer, and a tap on the rendered Deny button
// settled through the durable callback claim.
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

  /** The Telegram card for the ask, and a tap on the button with `label`. */
  function telegramChannel(tapLabel: string) {
    const rendered: { text?: string; buttons?: InlineButton[] } = {};
    const surface = {
      requestPermissionApproval: async (
        _jid: string,
        request: PermissionApprovalRequest,
      ): Promise<PermissionApprovalResult> => {
        await prepareTelegramPermissionCardSend({
          interactionCallbacksEnabled: true,
          bot: {
            api: {
              sendMessage: async (
                _chatId: string,
                text: string,
                options: {
                  reply_markup: { inline_keyboard: InlineButton[][] };
                },
              ) => {
                rendered.text = text;
                rendered.buttons = options.reply_markup.inline_keyboard.flat();
                return { message_id: 101 };
              },
            },
          } as never,
          jid: TARGET_JID,
          options: {
            permissionCardView: { request, providerAlias: request.requestId },
          },
        }).send();
        await bindPendingPermissionInteractionMessage({
          request,
          decisionOptions: permissionDecisionOptions(request),
        });
        const tapped = rendered.buttons?.find(
          (button) => button.text === tapLabel,
        );
        const mode = parseTelegramPermissionCallbackData(tapped!.callback_data)!
          .mode as PermissionApprovalDecisionMode;
        const claimed = await claimPermissionInteractionCallback({
          scope: {
            appId: request.appId ?? APP_ID,
            sourceAgentFolder: request.sourceAgentFolder,
            interactionId: request.requestId,
          },
          mode,
          approverRef: APPROVER,
          matchKind: 'individual',
        });
        if (claimed.status !== 'claimed') throw new Error(claimed.status);
        return {
          kind: 'decision',
          decision: {
            ...decisionForMode(request, mode, APPROVER),
            permissionCallbackClaim: claimed.claim,
          },
        };
      },
    };
    return { rendered, surface };
  }

  it('asks with what, which and why and the Allow once, Allow for future and Deny buttons, and a Deny tap denies the call', async () => {
    const channel = telegramChannel('Deny');
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => channel.surface,
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
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
    await processPermissionInteractionIpc({
      request,
      sourceAgentFolder: AGENT_FOLDER,
      deps,
      ipcBaseDir,
      file: path.basename(requestPath),
      claimedPath: claimed.claimedPath,
      logger,
    });

    expect(channel.rendered.text).toContain(
      'Allow Main Agent to use exact command access?',
    );
    expect(channel.rendered.text).toContain('Runs: gh');
    expect(channel.rendered.text).toContain(
      'Why: List my five newest repos for the weekly note',
    );
    expect(channel.rendered.buttons?.map((button) => button.text)).toEqual([
      'Allow once',
      'Allow for future',
      'Deny',
    ]);
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
});
