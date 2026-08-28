import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import { createGantryShellTool } from '@core/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.js';
import { createJobPermissionDurabilityWiring } from '@core/app/bootstrap/job-permission-durability-wiring.js';
import {
  bindPendingPermissionInteractionMessage,
  claimPermissionInteractionCallback,
  configurePendingInteractionDurability,
  configurePendingInteractionPermissionPersistence,
  findDurablePermissionInteractionByRequestId,
} from '@core/application/interactions/pending-interaction-durability.js';
import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
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
import { jobPermissionCardActions } from '@core/domain/job-permission-card-actions.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalResult,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import {
  interactionInFlightKey,
  processPermissionInteractionIpc,
} from '@core/runtime/ipc-interaction-processing.js';
import { processPermissionCancellationDirectory } from '@core/runtime/ipc-permission-cancellation-directory.js';
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
const runtimeLease = {
  tryAcquire: async () => ({ release: async () => {} }),
};

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
  'GANTRY_WORKSPACE_GROUP_DIR',
  'GANTRY_WORKSPACE_EXTRA_DIR',
  'GANTRY_IPC_DIR',
  'GANTRY_IPC_INPUT_DIR',
  'GANTRY_IPC_AUTH_TOKEN',
  'GANTRY_IPC_RESPONSE_VERIFY_KEY',
  'GANTRY_IPC_RESPONSE_KEY_ID',
  'GANTRY_APP_ID',
  'GANTRY_AGENT_ID',
  'GANTRY_CHAT_JID',
  'GANTRY_PERMISSION_LANE',
  'GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS',
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
      leases: runtimeLease,
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
      permissionRequestTimeoutMs: 0,
      permissionLane: 'interactive',
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
  ): (request: PermissionApprovalRequest) => Promise<PermissionApprovalResult> {
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
        kind: 'decision' as const,
        decision: {
          ...decisionForMode(request, mode, APPROVER),
          permissionCallbackClaim: claimed.claim,
        },
      };
    };
  }

  async function processNextSignedPermission(input: {
    requestPermissionApproval: IpcDeps['requestPermissionApproval'];
    jobPermissionDurability?: IpcDeps['jobPermissionDurability'];
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
      ...(input.jobPermissionDurability
        ? { jobPermissionDurability: input.jobPermissionDurability }
        : {}),
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

  it('completes the signed once-card chain for a job request with no persistable rule without writing a rule', async () => {
    const jobId = 'job-permission-once-chain';
    const runId = 'run-permission-once-chain';
    const workerId = 'worker-permission-once-chain';
    const now = new Date().toISOString();
    await runtime.ops.upsertJob({
      id: jobId,
      name: 'Permission once chain',
      prompt: 'Exercise the once permission chain',
      schedule_type: 'manual',
      schedule_value: '',
      status: 'active',
      session_id: null,
      thread_id: null,
      execution_context: {
        conversationJid: TARGET_JID,
        threadId: null,
        workspaceKey: AGENT_FOLDER,
        sessionId: null,
      },
      workspace_key: AGENT_FOLDER,
      created_by: APPROVER,
      created_at: now,
      updated_at: now,
      next_run: null,
      silent: true,
      timeout_ms: 30_000,
      max_retries: 0,
      retry_backoff_ms: 1,
    } satisfies JobUpsertInput);
    await runtime.repositories.workerCoordination.registerWorker({
      id: workerId,
      bootNonce: 'permission-once-chain',
    });
    const lease = await runtime.ops.claimDueJobRunStart({
      jobId,
      runId,
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId: workerId,
      scheduledFor: now,
      startedAt: now,
      retryCount: 0,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      requireNextRun: false,
    });
    expect(lease).not.toBeNull();

    const durability = createJobPermissionDurabilityWiring({
      repository: runtime.repositories.workerCoordination,
      opsRepository: runtime.ops,
      channelWiring: {
        isControlApproverAllowed: async () => true,
      },
      getPermissionRuntimeSettings: () => ({
        agents: { [AGENT_FOLDER]: { accessPreset: 'full' as const } },
        permissions: {},
      }),
      getToolRepository: () => runtime.repositories.tools,
      getSkillRepository: () => runtime.repositories.skills,
      resolveCardTarget: () => ({
        appId: APP_ID,
        conversationId: CONVERSATION_ID,
        threadId: null,
        agentId: AGENT_ID,
      }),
      enqueueRunAgain: async () => undefined,
    });
    const requestPermissionApproval = vi.fn(async () => {
      throw new Error('job permission request must use the durable card');
    });
    const ruleIdsBefore = (
      await runtime.service.db
        .select({ id: pgSchema.permissionRulesPostgres.id })
        .from(pgSchema.permissionRulesPostgres)
    )
      .map(({ id }) => id)
      .sort();
    const runnerDecision = requestPermissionApprovalViaIpc(
      clientEnv({
        jobId,
        jobName: 'Permission once chain',
        jobRunId: runId,
        jobRunLeaseToken: lease!.leaseToken,
        jobRunLeaseFencingVersion: String(lease!.fencingVersion),
        permissionLane: 'autonomous',
        permissionMode: 'ask',
        permissionRequestTimeoutMs: 5_000,
      }),
      {
        agentFolder: AGENT_FOLDER,
        toolName: 'RunCommand',
        toolInput: { command: 'npm test | tee permission-report.txt' },
      },
    );
    const processed = await processNextSignedPermission({
      requestPermissionApproval,
      jobPermissionDurability: durability,
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();

    let state =
      await runtime.repositories.workerCoordination.getJobPermissionState({
        appId: APP_ID,
        jobId,
      });
    expect(state!.needs).toEqual([
      expect.objectContaining({
        canonicalIdentity: processed.request.requestId,
        grant: 'once',
        renderedGrantAtoms: [],
        state: 'asking',
      }),
    ]);
    const revision = state!.card.revisions.at(-1)!;
    const allow = jobPermissionCardActions(
      state!.card.callbackKey,
      revision,
    ).find((action) => action.label === 'Allow');
    expect(allow).toBeDefined();
    await expect(
      durability.decideCardAction({
        actor: {
          actorRef: APPROVER,
          conversationJid: TARGET_JID,
          providerAccountId: PROVIDER_ACCOUNT_ID,
        },
        token: allow!.token,
      }),
    ).resolves.toMatchObject({ status: 'accepted' });
    await durability.reconcile();

    const decision = await runnerDecision;
    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'human_once',
    });
    expect(decision.updatedPermissions ?? null).toBeNull();
    state = await runtime.repositories.workerCoordination.getJobPermissionState(
      { appId: APP_ID, jobId },
    );
    expect(state!.needs[0]).toMatchObject({
      state: 'applied',
      grant: 'once',
      approvedGrantAtoms: [],
    });
    const ruleIdsAfter = (
      await runtime.service.db
        .select({ id: pgSchema.permissionRulesPostgres.id })
        .from(pgSchema.permissionRulesPostgres)
    )
      .map(({ id }) => id)
      .sort();
    expect(ruleIdsAfter).toEqual(ruleIdsBefore);
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
      permissionLane: 'autonomous',
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
    expect(JSON.stringify(toolResult)).toContain(
      'YOLO-mode denylist rule matched',
    );

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
      RUNTIME_EVENT_TYPES.PERMISSION_CANCELLED,
      RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
    ]);
    expect(events[2]?.payload).toMatchObject({
      decision: 'cancelled',
      decidedBy: 'hard_deny',
    });
    expect(events.at(-1)?.payload).toMatchObject({ approved: false });
    expect(events.map((event) => event.eventType)).not.toContain(
      RUNTIME_EVENT_TYPES.PERMISSION_DENIED,
    );
  }, 60_000);

  it('rejects a late approval after a claimed runner request is cancelled through the durable lane', async () => {
    let promptActive = false;
    let deliveredRequest: PermissionApprovalRequest | undefined;
    let resolvePrompt!: (decision: PermissionApprovalDecision) => void;
    let markPromptReady!: () => void;
    const promptReady = new Promise<void>((resolve) => {
      markPromptReady = resolve;
    });
    const cancelPendingPermission = vi.fn(
      async (
        cancellation: Parameters<
          NonNullable<IpcDeps['cancelPermissionApproval']>
        >[0],
      ) => {
        if (!promptActive || !deliveredRequest) return 'not_found' as const;
        const claimed = await claimPermissionInteractionCallback({
          scope: {
            appId: deliveredRequest.appId ?? APP_ID,
            sourceAgentFolder: deliveredRequest.sourceAgentFolder,
            interactionId: deliveredRequest.requestId,
          },
          mode: 'cancel',
          approverRef: 'runtime',
          matchKind: 'individual',
        });
        if (claimed.status === 'retryable') return 'retryable' as const;
        if (claimed.status === 'already_decided') {
          return 'already_decided' as const;
        }
        promptActive = false;
        resolvePrompt({
          ...decisionForMode(deliveredRequest, 'cancel', 'runtime'),
          reason: cancellation.reason,
          permissionCallbackClaim: claimed.claim,
        });
        return 'settled' as const;
      },
    );
    const permissionRequester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: async (
          _targetJid,
          request,
          onPromptDelivered,
        ) => {
          await expect(
            bindPendingPermissionInteractionMessage({
              request,
              decisionOptions: [
                'allow_once',
                'allow_persistent_rule',
                'cancel',
              ],
              externalMessageId: 'cancel-chain-prompt',
              provider: 'test',
              conversationId: TARGET_JID,
            }),
          ).resolves.toBe(true);
          deliveredRequest = request;
          promptActive = true;
          onPromptDelivered?.('cancel-chain-prompt');
          markPromptReady();
          return new Promise<PermissionApprovalResult>((resolve) => {
            resolvePrompt = (decision: PermissionApprovalDecision) =>
              resolve({ kind: 'decision', decision });
          });
        },
        cancelPendingPermission,
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });

    process.env.GANTRY_WORKSPACE_GROUP_DIR = path.join(ipcBaseDir, 'workspace');
    process.env.GANTRY_WORKSPACE_EXTRA_DIR = path.join(ipcBaseDir, 'extra');
    process.env.GANTRY_IPC_DIR = path.join(ipcBaseDir, AGENT_FOLDER);
    process.env.GANTRY_IPC_INPUT_DIR = path.join(ipcBaseDir, 'input');
    process.env.GANTRY_IPC_AUTH_TOKEN = ipcAuth.authToken;
    process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = ipcAuth.responseVerifyKey;
    process.env.GANTRY_IPC_RESPONSE_KEY_ID = ipcAuth.responseKeyId;
    process.env.GANTRY_APP_ID = APP_ID;
    process.env.GANTRY_AGENT_ID = AGENT_ID;
    process.env.GANTRY_CHAT_JID = TARGET_JID;
    process.env.GANTRY_PERMISSION_LANE = 'interactive';
    process.env.GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS = '0';
    vi.resetModules();
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');
    const controller = new AbortController();
    const runnerDecision = requestPermissionApproval({
      appId: APP_ID,
      agentId: AGENT_ID,
      workspaceFolder: AGENT_FOLDER,
      targetJid: TARGET_JID,
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
      signal: controller.signal,
    });
    const hostProcessing = processNextSignedPermission({
      requestPermissionApproval: permissionRequester,
    });

    await promptReady;
    expect(deliveredRequest).toBeDefined();
    const request = deliveredRequest!;
    const requestFile = `${request.requestId}.json`;
    const requestDir = runnerControl.requestDir(
      AGENT_FOLDER,
      'permission-requests',
    );
    expect(
      fs
        .readdirSync(requestDir)
        .some(
          (file) =>
            file.startsWith('.processing-') && file.endsWith(`-${requestFile}`),
        ),
    ).toBe(true);
    expect(promptActive).toBe(true);

    controller.abort();
    await expect(runnerDecision).resolves.toMatchObject({
      approved: false,
      reason: 'Permission request cancelled.',
      decisionClassification: 'user_reject',
    });
    const cancellationDir = runnerControl.requestDir(
      AGENT_FOLDER,
      'permission-cancellations',
    );
    expect(
      fs.readdirSync(cancellationDir).filter((file) => file.endsWith('.json')),
    ).toHaveLength(1);

    const inFlightInteractionIpc = new Set([
      interactionInFlightKey({
        sourceAgentFolder: AGENT_FOLDER,
        kind: 'permission',
        requestId: request.requestId,
      }),
    ]);
    const cancelPermissionApproval = vi.fn(permissionRequester.cancel);
    await processPermissionCancellationDirectory({
      sourceAgentFolder: AGENT_FOLDER,
      shouldProcessRequestLane: () => true,
      inFlightInteractionIpc,
      runnerControlPort: runnerControl,
      cancelPermissionApproval,
      publishRuntimeEvent: (event) =>
        runtime.storageRuntime.runtimeEvents
          .publish(event)
          .then(() => undefined),
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    await hostProcessing;

    expect(cancelPermissionApproval).toHaveBeenCalledOnce();
    expect(cancelPendingPermission).toHaveBeenCalledOnce();
    expect(promptActive).toBe(false);
    expect(
      fs.readdirSync(cancellationDir).filter((file) => file.endsWith('.json')),
    ).toEqual([]);
    expect(await interactionRow(request.requestId)).toMatchObject({
      status: 'cancelled',
      resolutionJson: {
        approved: false,
        mode: 'cancel',
      },
    });
    await expect(
      findDurablePermissionInteractionByRequestId({
        scope: {
          appId: APP_ID,
          sourceAgentFolder: AGENT_FOLDER,
          interactionId: request.requestId,
        },
      }),
    ).resolves.toBeNull();

    await expect(
      claimPermissionInteractionCallback({
        scope: {
          appId: APP_ID,
          sourceAgentFolder: AGENT_FOLDER,
          interactionId: request.requestId,
        },
        mode: 'allow_persistent_rule',
        approverRef: APPROVER,
        matchKind: 'individual',
      }),
    ).resolves.toEqual({ status: 'already_decided' });
    expect(await permissionDecisionRow(request.requestId)).toMatchObject({
      effect: 'deny',
    });
    expect(
      (await runtimeEvents(request.requestId)).map((event) => event.eventType),
    ).not.toContain(RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED);
  }, 60_000);
});
