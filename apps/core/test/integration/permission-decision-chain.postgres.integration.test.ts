import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import { createGantryShellTool } from '@core/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.js';
import {
  bindPendingPermissionInteractionMessage,
  claimPermissionInteractionCallback,
  configurePendingInteractionDurability,
  configurePendingInteractionPermissionPersistence,
} from '@core/application/interactions/pending-interaction-durability.js';
import { createAgentToolRuleSettingsMirror } from '@core/config/settings/agent-tool-rule-settings-mirror.js';
import { GANTRY_HOME, RUNTIME_SETTINGS_PATH } from '@core/config/index.js';
import {
  ensureConfiguredAgent,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { AGENT_CREDENTIAL_ENV_KEYS } from '@core/config/source-classification.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { decisionForMode } from '@core/domain/permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import { processPermissionInteractionIpc } from '@core/runtime/ipc-interaction-processing.js';
import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';
import {
  parsePermissionIpcRequest,
  type ParsedPermissionIpcRequest,
} from '@core/runtime/ipc-parsing.js';
import {
  requestPermissionApprovalViaIpc,
  type PermissionApprovalRequestOptions,
  type PermissionDecisionResult,
  type PermissionIpcRuntimeEnv,
} from '@core/runner/permission-ipc-client.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'default';
const AGENT_ID = 'agent:main_agent';
const AGENT_FOLDER = 'main_agent';
const APPROVER = 'user:permission-chain';
const TARGET_JID = 'tg:permission-chain';
const PROVIDER_ACCOUNT_ID = 'provider-account:permission-chain';
const CONVERSATION_ID = `conversation:${TARGET_JID}`;
const ENV_KEYS = [
  'GANTRY_DATABASE_URL',
  'SECRET_ENCRYPTION_KEY',
  'TZ',
  'LANG',
  'LC_ALL',
  ...AGENT_CREDENTIAL_ENV_KEYS,
] as const;

type CapturedLog = {
  level: 'error' | 'info' | 'warn';
  context: Record<string, unknown>;
  message: string;
};

type DriveResult = {
  decision: PermissionDecisionResult;
  logs: CapturedLog[];
  rawRequest: Record<string, unknown>;
  request: ParsedPermissionIpcRequest;
};

maybeDescribe('permission decision durable IPC chain (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let ipcBaseDir: string;
  let originalSettingsYaml: string;
  let originalEnv: Record<string, string | undefined>;
  let mirrorAgentToolRulesToSettings: ReturnType<
    typeof createAgentToolRuleSettingsMirror
  >;
  let ipcAuth: ReturnType<typeof createIpcAuthEnvelope>;
  let runnerControl: FilesystemRunnerControlPort;

  beforeAll(async () => {
    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    process.env.TZ = 'UTC';
    process.env.LANG = 'C.UTF-8';
    process.env.LC_ALL = 'C.UTF-8';
    for (const key of AGENT_CREDENTIAL_ENV_KEYS) delete process.env[key];

    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'perm_chain',
    });
    const now = new Date().toISOString();
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: PROVIDER_ACCOUNT_ID as never,
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
      providerId: 'telegram' as never,
      externalIdentityRef: {
        kind: 'provider_account',
        value: 'permission-chain',
      },
      label: 'Permission chain integration',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: CONVERSATION_ID as never,
      appId: APP_ID as never,
      providerAccountId: PROVIDER_ACCOUNT_ID as never,
      externalRef: { kind: 'conversation', value: TARGET_JID },
      kind: 'channel',
      title: 'Permission chain integration',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    process.env.GANTRY_DATABASE_URL = process.env.GANTRY_TEST_DATABASE_URL;
    process.env.SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

    originalSettingsYaml = fs.readFileSync(RUNTIME_SETTINGS_PATH, 'utf-8');
    const settings = loadRuntimeSettings(GANTRY_HOME);
    settings.desiredState.authoritative = true;
    ensureConfiguredAgent(settings, {
      agentId: AGENT_FOLDER,
      agentName: 'Main Agent',
      agentFolder: AGENT_FOLDER,
    });
    saveRuntimeSettings(GANTRY_HOME, settings);

    mirrorAgentToolRulesToSettings = createAgentToolRuleSettingsMirror({
      opsRepository: runtime.ops,
      repositories: runtime.repositories,
      reloadRuntimeState: async () => {},
    });
    configurePendingInteractionDurability({
      repository: runtime.repositories.workerCoordination,
      warn: (context, message) =>
        console.error(message, context.err ?? context),
    });
    configurePendingInteractionPermissionPersistence({
      opsRepository: runtime.ops,
      getToolRepository: () => runtime.repositories.tools,
      getPermissionRepository: () => runtime.repositories.permissions,
      mirrorAgentToolRulesToSettings,
    });

    ipcBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-perm-chain-'));
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
    for (const [key, value] of Object.entries(originalEnv ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (runtime) await runtime.cleanup();
    if (ipcBaseDir) fs.rmSync(ipcBaseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function clientEnv(
    overrides: Partial<PermissionIpcRuntimeEnv> = {},
  ): PermissionIpcRuntimeEnv {
    return {
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
      permissionRequestTimeoutMs: 10_000,
      resolveWorkspaceIpcDir: (folder) => path.join(ipcBaseDir, folder),
      ...overrides,
    };
  }

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
    throw new Error('Timed out waiting for signed permission IPC request');
  }

  async function interactionRow(requestId: string) {
    const rows = await runtime.service.db
      .select()
      .from(pgSchema.pendingInteractionsPostgres)
      .where(eq(pgSchema.pendingInteractionsPostgres.requestId, requestId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function permissionDecisionRow(requestId: string) {
    const rows = await runtime.service.db
      .select()
      .from(pgSchema.permissionDecisionsPostgres)
      .where(eq(pgSchema.permissionDecisionsPostgres.appId, APP_ID));
    const matching = rows.filter((row) => {
      const context = JSON.parse(row.actorContextJson ?? 'null') as {
        requestId?: string;
      } | null;
      return context?.requestId === requestId;
    });
    expect(matching).toHaveLength(1);
    return matching[0]!;
  }

  async function runtimeEvents(requestId: string) {
    const events = await runtime.repositories.runtimeEvents.listRuntimeEvents({
      appId: APP_ID as never,
      limit: 100,
    });
    return events.filter((event) => event.correlationId === requestId);
  }

  function buttonDecision(
    mode: PermissionApprovalDecisionMode,
    beforeBind?: (request: PermissionApprovalRequest) => Promise<void>,
  ): (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision> {
    return async (request) => {
      await beforeBind?.(request);
      const decisionOptions: PermissionApprovalDecisionMode[] =
        mode === 'allow_persistent_rule'
          ? ['allow_once', 'allow_persistent_rule', 'cancel']
          : ['allow_once', 'cancel'];
      await expect(
        bindPendingPermissionInteractionMessage({ request, decisionOptions }),
      ).resolves.toBe(true);
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
      expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') {
        throw new Error(
          `Expected claimed permission callback, got ${claimed.status}`,
        );
      }
      return {
        ...decisionForMode(request, mode, APPROVER),
        permissionCallbackClaim: claimed.claim,
      };
    };
  }

  async function processNextSignedPermission(input: {
    requestPermissionApproval: IpcDeps['requestPermissionApproval'];
    sendMessage?: IpcDeps['sendMessage'];
    classifierConsult?: IpcDeps['classifierConsult'];
    getPermissionRuntimeSettings?: IpcDeps['getPermissionRuntimeSettings'];
  }): Promise<Omit<DriveResult, 'decision'>> {
    const requestPath = await waitForPermissionRequest();
    const claimed = runnerControl.claimRequest(
      AGENT_FOLDER,
      'permission-requests',
      path.basename(requestPath),
    );
    const rawRequest = claimed.raw as Record<string, unknown>;
    const request = parsePermissionIpcRequest(rawRequest, AGENT_FOLDER);

    const logs: CapturedLog[] = [];
    const logger = {
      info: (context: Record<string, unknown>, message: string) => {
        logs.push({ level: 'info' as const, context, message });
      },
      warn: (context: Record<string, unknown>, message: string) => {
        logs.push({ level: 'warn' as const, context, message });
      },
      error: (context: Record<string, unknown>, message: string) => {
        logs.push({ level: 'error' as const, context, message });
      },
    };
    const deps: IpcDeps = {
      sendMessage: input.sendMessage ?? vi.fn(async () => undefined),
      conversationRoutes: () => ({}),
      registerGroup: async () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: async () => undefined,
      onSchedulerChanged: () => undefined,
      requestPermissionApproval: input.requestPermissionApproval,
      requestUserAnswer: async () => ({ answers: {} }),
      opsRepository: runtime.ops,
      getToolRepository: () => runtime.repositories.tools,
      getPermissionRepository: () => runtime.repositories.permissions,
      mirrorAgentToolRulesToSettings,
      publishRuntimeEvent: (event) =>
        runtime.storageRuntime.runtimeEvents
          .publish(event)
          .then(() => undefined),
      ...(input.classifierConsult
        ? { classifierConsult: input.classifierConsult }
        : {}),
      ...(input.getPermissionRuntimeSettings
        ? { getPermissionRuntimeSettings: input.getPermissionRuntimeSettings }
        : {}),
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
    return {
      logs,
      rawRequest,
      request,
    };
  }

  async function driveSignedPermission(input: {
    options: PermissionApprovalRequestOptions;
    requestPermissionApproval: IpcDeps['requestPermissionApproval'];
    env?: Partial<PermissionIpcRuntimeEnv>;
    sendMessage?: IpcDeps['sendMessage'];
    classifierConsult?: IpcDeps['classifierConsult'];
    getPermissionRuntimeSettings?: IpcDeps['getPermissionRuntimeSettings'];
  }): Promise<DriveResult> {
    const decisionPromise = requestPermissionApprovalViaIpc(
      clientEnv(input.env),
      input.options,
    );
    const processed = await processNextSignedPermission(input);
    return {
      ...processed,
      decision: await decisionPromise,
    };
  }

  it('completes the signed allow-once chain after durable record-before-prompt without credential leakage', async () => {
    const modelCredentialMarker = 'model-credential-marker-f7d42';
    const capabilitySecretMarker = 'capability-secret-marker-91ac3';
    const requestPermissionApproval = vi.fn(
      buttonDecision('allow_once', async (request) => {
        const pending = await interactionRow(request.requestId);
        expect(pending.status).toBe('pending');
        expect(
          (await runtimeEvents(request.requestId)).map(
            (event) => event.eventType,
          ),
        ).toEqual([
          RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
          RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
        ]);
      }),
    );

    const result = await driveSignedPermission({
      options: {
        agentFolder: AGENT_FOLDER,
        toolName: 'WebFetch',
        toolInput: {
          url: 'https://example.invalid/report',
          apiKey: modelCredentialMarker,
          nested: { password: capabilitySecretMarker },
        },
      },
      requestPermissionApproval,
    });

    const rawRequestText = JSON.stringify(result.rawRequest);
    expect(rawRequestText).toContain(modelCredentialMarker);
    expect(rawRequestText).toContain(capabilitySecretMarker);
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(result.decision).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: APPROVER,
      decisionClassification: 'user_temporary',
    });

    const pending = await interactionRow(result.request.requestId);
    expect(pending).toMatchObject({
      status: 'resolved',
      approverRef: APPROVER,
      resolutionJson: {
        approved: true,
        mode: 'allow_once',
      },
    });
    const auditDecision = await permissionDecisionRow(result.request.requestId);
    expect(auditDecision).toMatchObject({
      effect: 'allow',
      approverRef: APPROVER,
    });
    const events = await runtimeEvents(result.request.requestId);
    expect(events.map((event) => event.eventType)).toEqual([
      RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
      RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
      RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED,
      RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
      RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
    ]);

    const durableEvidence = JSON.stringify({
      pending,
      auditDecision,
      events,
      logs: result.logs,
      signedDecision: result.decision,
    });
    expect(durableEvidence).not.toContain(modelCredentialMarker);
    expect(durableEvidence).not.toContain(capabilitySecretMarker);
  }, 60_000);

  it('persists allow-for-future through the signed chain without an outbound chat receipt', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const result = await driveSignedPermission({
      options: {
        agentFolder: AGENT_FOLDER,
        toolName: 'Bash',
        toolInput: {
          command: '/usr/local/bin/permission-chain-report --daily',
        },
      },
      requestPermissionApproval: buttonDecision('allow_persistent_rule'),
      sendMessage,
    });

    expect(result.decision).toMatchObject({
      approved: true,
      mode: 'allow_persistent_rule',
      decisionClassification: 'user_permanent',
    });
    expect((await interactionRow(result.request.requestId)).status).toBe(
      'resolved',
    );
    const events = await runtimeEvents(result.request.requestId);
    expect(events.map((event) => event.eventType)).toContain(
      RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED,
    );
    expect(sendMessage).not.toHaveBeenCalled();

    const outboundMessages = await runtime.service.db
      .select()
      .from(pgSchema.messagesPostgres)
      .where(eq(pgSchema.messagesPostgres.direction, 'outbound'));
    expect(outboundMessages).toEqual([]);
    expect(
      events.filter((event) =>
        [
          RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
          RUNTIME_EVENT_TYPES.CONVERSATION_MESSAGE_OUTBOUND,
        ].includes(event.eventType as never),
      ),
    ).toEqual([]);
  }, 60_000);

  it('converts a signed unattended YOLO denylist hit into terminal deny evidence without prompting or execution', async () => {
    // Attended ask/event behavior is already covered by
    // permission-classifier.test.ts:868-941; this covers only unattended IPC.
    const sideEffectPath = path.join(ipcBaseDir, 'must-not-exist');
    const command = `touch ${sideEffectPath}`;
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: APPROVER,
      decisionClassification: 'user_reject' as const,
    }));
    const classifierConsult = vi.fn();
    const permissionEnv = clientEnv({
      permissionRequestTimeoutMs: 0,
      permissionMode: 'auto',
    });
    const tool = createGantryShellTool({
      workspaceFolder: AGENT_FOLDER,
      memoryBlock: '',
      configuredAllowedTools: [],
      gateContext: { conversationId: TARGET_JID },
      permissionEnv,
      lockedAccessPreset: false,
      cwd: ipcBaseDir,
    });
    const toolResultPromise = tool.invoke({ command } as never);
    const result = await processNextSignedPermission({
      requestPermissionApproval,
      classifierConsult,
      getPermissionRuntimeSettings: () =>
        ({
          agents: {
            [AGENT_FOLDER]: {
              permissionMode: 'auto',
              capabilities: [],
            },
          },
          permissions: {
            autoMode: {},
            yoloMode: {
              enabled: true,
              denylist: [command],
              denylistPaths: [],
            },
          },
          memory: { llm: { models: { extractor: 'haiku' } } },
        }) as never,
    });
    const toolResult = await toolResultPromise;

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(classifierConsult).not.toHaveBeenCalled();
    expect(fs.existsSync(sideEffectPath)).toBe(false);
    expect(JSON.stringify(toolResult)).toContain('Permission denied');

    const pending = await interactionRow(result.request.requestId);
    expect(pending).toMatchObject({
      status: 'cancelled',
      resolutionJson: {
        approved: false,
        mode: 'cancel',
      },
    });
    expect(await permissionDecisionRow(result.request.requestId)).toMatchObject(
      {
        effect: 'deny',
      },
    );
    const events = await runtimeEvents(result.request.requestId);
    expect(events.map((event) => event.eventType)).toEqual([
      RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
      RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
      RUNTIME_EVENT_TYPES.PERMISSION_YOLO_DENYLIST_HIT,
      RUNTIME_EVENT_TYPES.PERMISSION_CLASSIFIER_DECISION,
      RUNTIME_EVENT_TYPES.PERMISSION_CANCELLED,
      RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ approved: false });
    expect(events.map((event) => event.eventType)).not.toContain(
      RUNTIME_EVENT_TYPES.PERMISSION_DENIED,
    );
  }, 60_000);
});
