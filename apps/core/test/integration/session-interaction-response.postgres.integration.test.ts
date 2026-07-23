import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import {
  DEFAULT_AGENT_CONFIG_VERSION_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import {
  beginDurablePermissionInteraction,
  beginDurableQuestionInteraction,
} from '@core/application/interactions/durable-interaction-handler.js';
import {
  configurePendingInteractionDurability,
  configurePendingInteractionPermissionPersistence,
} from '@core/application/interactions/pending-interaction-durability.js';
import { durablePermissionRequestSnapshot } from '@core/application/interactions/pending-interaction-permission-envelope.js';
import { synthesizeHostPermissionSuggestions } from '@core/application/permissions/permission-suggestion-synthesis.js';
import { GANTRY_HOME, RUNTIME_SETTINGS_PATH } from '@core/config/index.js';
import { createAgentToolRuleSettingsMirror } from '@core/config/settings/agent-tool-rule-settings-mirror.js';
import {
  capabilityToToolRule,
  ensureConfiguredAgent,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { permissionUpdateAllowedToolRules } from '@core/shared/permission-tool-rules.js';

import { startTestControlServer } from '../harness/control-http-server.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'default';
const AGENT_ID = 'agent:main_agent';
const AGENT_FOLDER = 'main_agent';
const CONVERSATION_ID = 'conv-approvals';
const CHAT_JID = `app:${APP_ID}:${CONVERSATION_ID}`;
const TOKEN = 'token-session-interaction-response';
const WRITE_ONLY_TOKEN = 'token-session-interaction-write-only';

// The respond route must ride the SAME durable authority chain the channel
// permission callbacks ride (claim → applyPendingInteractionGrantDecision →
// durable resolution; see pending-interaction-permission-callback.ts and
// permission-durable-authority.postgres.integration.test.ts, which drives the
// identical chain through the raw claim functions). This suite drives it
// through the HTTP route with a REAL Postgres runtime: real pending rows,
// real prompt binding, real claim CAS, real transient grants, and the real
// settings mirror for allow_future.
maybeDescribe('session interaction response API (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let server: Awaited<ReturnType<typeof startTestControlServer>>;
  let sessionId: string;
  let originalSettingsYaml: string;
  let originalEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'sess_iresp',
    });
    originalEnv = {
      GANTRY_DATABASE_URL: process.env.GANTRY_DATABASE_URL,
      SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY,
    };
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

    // Real runtime storage behind the control server route handlers; this
    // also configures pending-interaction durability over the same
    // workerCoordination repository (runtime-store.ts).
    _setRuntimeStorageForTest(runtime.storageRuntime);
    configurePendingInteractionDurability({
      repository: runtime.repositories.workerCoordination,
      liveTurns: runtime.repositories.liveTurns,
      warn: (context, message) => {
        console.error(message, context.err ?? context);
      },
    });
    configurePendingInteractionPermissionPersistence({
      opsRepository: runtime.ops,
      getToolRepository: () => runtime.repositories.tools,
      getPermissionRepository: () => runtime.repositories.permissions,
      mirrorAgentToolRulesToSettings: createAgentToolRuleSettingsMirror({
        opsRepository: runtime.ops,
        repositories: runtime.repositories,
        reloadRuntimeState: async () => {},
      }),
    });

    server = await startTestControlServer({
      token: TOKEN,
      appId: APP_ID,
      scopes: ['sessions:read', 'sessions:write', 'approvals:write'],
      extraKeys: [
        {
          kid: 'write-only',
          token: WRITE_ONLY_TOKEN,
          scopes: ['sessions:read', 'sessions:write'],
          appId: APP_ID,
        },
      ],
      runtimeApp: {
        registerGroup: async () => undefined,
        queue: { enqueueMessageCheck: () => undefined },
      },
      liveTurnsEnabled: false,
    });

    const ensured = await fetch(`${server.baseUrl}/v1/sessions/ensure`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: CONVERSATION_ID,
        agentId: AGENT_ID,
      }),
    });
    expect(ensured.status).toBe(200);
    const ensuredBody = (await ensured.json()) as {
      sessionId: string;
      chatJid: string;
    };
    sessionId = ensuredBody.sessionId;
    expect(ensuredBody.chatJid).toBe(CHAT_JID);
  }, 120_000);

  afterAll(async () => {
    configurePendingInteractionDurability(null);
    configurePendingInteractionPermissionPersistence(null);
    await server?.close();
    if (originalSettingsYaml !== undefined) {
      fs.writeFileSync(RUNTIME_SETTINGS_PATH, originalSettingsYaml, 'utf-8');
    }
    for (const [key, value] of Object.entries(originalEnv ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (runtime) await runtime.cleanup();
  }, 60_000);

  function makeRequest(
    requestId: string,
    command: string,
    run?: { runId: string; leaseToken: string; fencingVersion: number },
  ): PermissionApprovalRequest {
    return {
      requestId,
      appId: APP_ID,
      agentId: AGENT_ID,
      sourceAgentFolder: AGENT_FOLDER,
      targetJid: CHAT_JID,
      toolName: 'Bash',
      toolInput: { command },
      suggestions: synthesizeHostPermissionSuggestions('Bash', { command }),
      ...(run
        ? {
            runId: run.runId,
            runLeaseToken: run.leaseToken,
            runLeaseFencingVersion: run.fencingVersion,
          }
        : {}),
    };
  }

  // The same seam the IPC processor uses to create pending_interactions rows
  // before any prompt renders (ipc-interaction-processing.ts).
  async function drivePendingPermission(request: PermissionApprovalRequest) {
    await beginDurablePermissionInteraction({
      request,
      sourceAgentFolder: request.sourceAgentFolder,
      payload: {
        sourceAgentFolder: request.sourceAgentFolder,
        requestId: request.requestId,
        toolName: request.toolName,
        request: durablePermissionRequestSnapshot(request),
      },
      callbackRoute: null,
    });
  }

  async function respond(
    interactionId: string,
    decision: string,
    token = TOKEN,
  ) {
    const response = await fetch(
      `${server.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision }),
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  }

  async function listInteractions() {
    const response = await fetch(
      `${server.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/interactions`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      interactions: Array<Record<string, unknown>>;
    };
  }

  async function interactionRow(requestId: string) {
    const rows = await runtime.service.db
      .select()
      .from(pgSchema.pendingInteractionsPostgres)
      .where(eq(pgSchema.pendingInteractionsPostgres.requestId, requestId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  function settingsAgentRules(): string[] {
    const agent = loadRuntimeSettings(GANTRY_HOME).agents[AGENT_FOLDER];
    expect(agent).toBeDefined();
    return agent!.capabilities.map((capability) =>
      capabilityToToolRule(capability.id),
    );
  }

  it('lists the pending permission interaction with its decision options', async () => {
    const request = makeRequest(
      'req-iresp-list',
      '/usr/local/bin/list-me --now',
    );
    await drivePendingPermission(request);

    const { interactions } = await listInteractions();
    const listed = interactions.find((entry) => entry.id === 'req-iresp-list');
    expect(listed).toMatchObject({
      id: 'req-iresp-list',
      kind: 'permission',
      toolName: 'Bash',
      options: ['allow_once', 'allow_future', 'deny'],
    });
    expect(typeof listed!.createdAt).toBe('string');
  }, 60_000);

  it('allow_once resolves through the channel-callback chain and grants run-scoped transient authority only', async () => {
    const command = '/usr/local/bin/send-digest --weekly';
    const runId = 'run-iresp-once';
    const workerId = 'worker-iresp-once';
    const now = new Date().toISOString();
    await runtime.service.db
      .insert(pgSchema.agentRunsPostgres)
      .values({
        id: runId,
        appId: APP_ID,
        agentId: AGENT_ID,
        configVersionId: DEFAULT_AGENT_CONFIG_VERSION_ID,
        llmProfileId: DEFAULT_LLM_PROFILE_ID,
        executionProviderId: 'test:integration',
        cause: 'integration',
        status: 'running',
        permissionDecisionIdsJson: '[]',
        createdAt: now,
        startedAt: now,
      })
      .onConflictDoNothing();
    await runtime.repositories.workerCoordination.registerWorker({
      id: workerId,
      bootNonce: 'iresp-once',
    });
    const lease = await runtime.repositories.workerCoordination.claimRunLease({
      runId,
      workerInstanceId: workerId,
      ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();

    const request = makeRequest('req-iresp-once', command, {
      runId,
      leaseToken: lease!.leaseToken,
      fencingVersion: lease!.fencingVersion,
    });
    await drivePendingPermission(request);

    const result = await respond('req-iresp-once', 'allow_once');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'resolved',
      interactionId: 'req-iresp-once',
      decision: 'allow_once',
      decidedBy: 'api-key:test',
    });

    // Same durable evidence the channel path leaves behind.
    const row = await interactionRow('req-iresp-once');
    expect(row.status).toBe('resolved');
    expect(row.resolutionJson).toMatchObject({
      approved: true,
      mode: 'allow_once',
    });
    expect(row.approverRef).toBe('api-key:test');

    const grants =
      await runtime.repositories.workerCoordination.listActiveTransientGrants({
        runId,
      });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.leaseToken).toBe(lease!.leaseToken);
    expect(grants[0]!.grant).toMatchObject({
      toolName: 'Bash',
      mode: 'allow_once',
      requestId: 'req-iresp-once',
    });

    // Once-only: no durable rule was mirrored to settings.
    expect(
      settingsAgentRules().some((rule) => rule.includes('send-digest')),
    ).toBe(false);

    // A second respond hits the already-resolved guard, not a re-decision.
    const again = await respond('req-iresp-once', 'deny');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INTERACTION_ALREADY_RESOLVED');
  }, 60_000);

  it('allow_future persists the durable rule and settings mirror exactly like a channel allow-forever', async () => {
    const command = '/usr/local/bin/report-status --daily';
    const request = makeRequest('req-iresp-future', command);
    const [expectedRule] = permissionUpdateAllowedToolRules(
      request.suggestions,
    );
    expect(expectedRule).toBe(`RunCommand(${command})`);
    await drivePendingPermission(request);

    const result = await respond('req-iresp-future', 'allow_future');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'resolved',
      decision: 'allow_future',
      decidedBy: 'api-key:test',
    });

    const row = await interactionRow('req-iresp-future');
    expect(row.status).toBe('resolved');
    expect(row.resolutionJson).toMatchObject({
      approved: true,
      mode: 'allow_persistent_rule',
    });
    expect(row.approverRef).toBe('api-key:test');

    // Durable rule: active agent tool binding + the settings.yaml mirror,
    // via the same createAgentToolRuleSettingsMirror wiring production uses.
    const bindings = await runtime.repositories.tools.listAgentToolBindings({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
    });
    const boundTools = await Promise.all(
      bindings
        .filter((binding) => binding.status === 'active')
        .map((binding) => runtime.repositories.tools.getTool(binding.toolId)),
    );
    expect(boundTools.some((tool) => tool?.name === expectedRule)).toBe(true);
    expect(settingsAgentRules()).toContain(expectedRule);

    // Audit row from the real persistent-grant path.
    const decisions = await runtime.service.db
      .select()
      .from(pgSchema.permissionDecisionsPostgres)
      .where(eq(pgSchema.permissionDecisionsPostgres.appId, APP_ID));
    const granted = decisions
      .map((decision) => ({
        ...decision,
        actorContext: JSON.parse(decision.actorContextJson ?? 'null') as {
          requestId?: string;
        } | null,
      }))
      .find(
        (decision) => decision.actorContext?.requestId === 'req-iresp-future',
      );
    expect(granted).toBeDefined();
    expect(granted!.effect).toBe('allow');
    expect(granted!.approverRef).toBe('api-key:test');
  }, 60_000);

  it('deny resolves the interaction as cancelled with no grants', async () => {
    const command = '/usr/local/bin/rotate-keys --now';
    const request = makeRequest('req-iresp-deny', command);
    await drivePendingPermission(request);

    const result = await respond('req-iresp-deny', 'deny');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'resolved', decision: 'deny' });

    const row = await interactionRow('req-iresp-deny');
    expect(row.status).toBe('cancelled');
    expect(row.resolutionJson).toMatchObject({
      approved: false,
      mode: 'cancel',
    });
    expect(
      settingsAgentRules().some((rule) => rule.includes('rotate-keys')),
    ).toBe(false);
  }, 60_000);

  it('rejects a sessions:write-only key with 403 on respond', async () => {
    const request = makeRequest(
      'req-iresp-scope',
      '/usr/local/bin/scope-check --x',
    );
    await drivePendingPermission(request);

    const result = await respond(
      'req-iresp-scope',
      'allow_once',
      WRITE_ONLY_TOKEN,
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('approvals:write');

    // The interaction is untouched and still decidable.
    const row = await interactionRow('req-iresp-scope');
    expect(row.status).toBe('pending');
  }, 60_000);

  it('rejects question interactions with a clear v1 limitation error', async () => {
    const began = await beginDurableQuestionInteraction({
      request: {
        requestId: 'req-iresp-question',
        sourceAgentFolder: AGENT_FOLDER,
        appId: APP_ID,
        targetJid: CHAT_JID,
        questions: [
          {
            question: 'Deploy now?',
            header: 'Deploy',
            options: [
              { label: 'Yes', description: 'Ship it' },
              { label: 'No', description: 'Hold off' },
            ],
            multiSelect: false,
          },
        ],
      },
      sourceAgentFolder: AGENT_FOLDER,
    });
    expect(began).toBe(true);

    const { interactions } = await listInteractions();
    const listed = interactions.find(
      (entry) => entry.id === 'req-iresp-question',
    );
    expect(listed).toMatchObject({
      kind: 'question',
      questions: ['Deploy now?'],
      options: [],
    });

    const result = await respond('req-iresp-question', 'deny');
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('INTERACTION_KIND_UNSUPPORTED');
    expect(result.body.error.message).toContain('permission interactions');
  }, 60_000);

  it('returns 404 for an unknown interaction and 400 for an unknown decision', async () => {
    const missing = await respond('req-iresp-missing', 'allow_once');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('INTERACTION_NOT_FOUND');

    const request = makeRequest(
      'req-iresp-bad-decision',
      '/usr/local/bin/bad-decision --x',
    );
    await drivePendingPermission(request);
    const bad = await respond('req-iresp-bad-decision', 'allow_5_minutes');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_REQUEST');
  }, 60_000);
});
