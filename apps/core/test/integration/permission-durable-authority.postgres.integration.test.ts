import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresDomainRepositories } from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import { PostgresRuntimeRepositoryBundle } from '@core/adapters/storage/postgres/schema/canonical-ops-repo.postgres.js';
import { PostgresRuntimeEventNotifier } from '@core/adapters/storage/postgres/runtime-event-notifier.postgres.js';
import {
  DEFAULT_AGENT_CONFIG_VERSION_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { PostgresStorageService } from '@core/adapters/storage/postgres/storage-service.js';
import { beginDurablePermissionInteraction } from '@core/application/interactions/durable-interaction-handler.js';
import {
  bindPendingPermissionInteractionMessage,
  claimPermissionInteractionCallback,
  configurePendingInteractionDurability,
  configurePendingInteractionPermissionPersistence,
  resolveDurablePermissionInteractionByRequestId,
} from '@core/application/interactions/pending-interaction-durability.js';
import { durablePermissionRequestSnapshot } from '@core/application/interactions/pending-interaction-permission-envelope.js';
import { synthesizeHostPermissionSuggestions } from '@core/application/permissions/permission-suggestion-synthesis.js';
import { RuntimeEventExchange } from '@core/application/runtime-events/runtime-event-exchange.js';
import { GANTRY_HOME, RUNTIME_SETTINGS_PATH } from '@core/config/index.js';
import { createAgentToolRuleSettingsMirror } from '@core/config/settings/agent-tool-rule-settings-mirror.js';
import { SettingsDesiredStateService } from '@core/config/settings/desired-state-service.js';
import {
  capabilityToToolRule,
  ensureConfiguredAgent,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import type { PermissionApprovalDecisionMode } from '@core/domain/types.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { evaluateAutonomousToolUse } from '@core/shared/tool-rule-matcher.js';
import { permissionUpdateAllowedToolRules } from '@core/shared/permission-tool-rules.js';
import { resolveConfiguredAllowedTools } from '@core/runtime/configured-agent-tools.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

// Uses the seeded default app/agent (seeds.ts). A second configured agent
// guards the (appId, agentId) scoping of durable rules: a regression to
// app-wide binding lookups would leak AGENT_ID's rule to it.
const APP_ID = 'default';
const AGENT_ID = 'agent:main_agent';
const AGENT_FOLDER = 'main_agent';
const SECOND_AGENT_ID = 'agent:second_agent';
const SECOND_AGENT_FOLDER = 'second_agent';
const APPROVER = 'user:approver';

// Matrix §6 durable-authority chain, driven through the REAL channel
// button-resolution path: durable pending interaction → prompt binding →
// claim → resolveDurablePermissionInteractionByRequestId (the same functions
// the Slack/Telegram callback handlers invoke; see
// pending-interaction-permission-callback.ts). No decide-API is invented.
//
// Persistence uses the REAL production wiring (runtime-services.ts):
// createAgentToolRuleSettingsMirror over the full repository bundle, so an
// allow_persistent_rule decision writes desired-state settings + a settings
// revision and reconciles it (agent-tool-rule-settings-mirror.ts →
// restart-sync.ts → desired-state-capability-reconcile.ts) — no recorder
// stubs. `desired_state.authoritative: true` means restart reconciliation
// REPLACES agent capability bindings from settings.yaml, so the restart
// assertions can only pass through the settings mirror: a binding that exists
// only as a raw DB row is wiped by the reconcile in restartAndEvaluateGate.
//
// Note: PERMISSION_* runtime events are published by the IPC processor
// (ipc-interaction-processing.ts), not by this decision-application path, so
// the durable evidence asserted here is rows: pending_interactions status +
// resolution, agent tool bindings, settings.yaml capabilities, transient
// grants, and permission_decisions.
maybeDescribe('permission durable authority chain (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let originalSettingsYaml: string;
  let originalEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'perm_durable',
    });
    // The REAL settings-import preflight (validateLoadedRuntimeSettings)
    // requires runtime storage + credential-encryption env. Satisfy it with
    // this run's own throwaway integration database — the runtime under test.
    originalEnv = {
      GANTRY_DATABASE_URL: process.env.GANTRY_DATABASE_URL,
      SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY,
    };
    process.env.GANTRY_DATABASE_URL = process.env.GANTRY_TEST_DATABASE_URL;
    process.env.SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    // Declare both agents in the runtime settings the way production setup
    // flows do (ensureConfiguredAgent), with authoritative desired state.
    originalSettingsYaml = fs.readFileSync(RUNTIME_SETTINGS_PATH, 'utf-8');
    const settings = loadRuntimeSettings(GANTRY_HOME);
    settings.desiredState.authoritative = true;
    ensureConfiguredAgent(settings, {
      agentId: AGENT_FOLDER,
      agentName: 'Main Agent',
      agentFolder: AGENT_FOLDER,
    });
    ensureConfiguredAgent(settings, {
      agentId: SECOND_AGENT_FOLDER,
      agentName: 'Second Agent',
      agentFolder: SECOND_AGENT_FOLDER,
    });
    saveRuntimeSettings(GANTRY_HOME, settings);

    configurePendingInteractionDurability({
      repository: runtime.repositories.workerCoordination,
      warn: (context, message) => {
        console.error(message, context.err ?? context);
      },
    });
    configurePendingInteractionPermissionPersistence({
      opsRepository: runtime.ops,
      getToolRepository: () => runtime.repositories.tools,
      getPermissionRepository: () => runtime.repositories.permissions,
      // REAL settings mirror (same factory + arguments as runtime-services.ts),
      // including the settings-revision append via the full repository bundle.
      mirrorAgentToolRulesToSettings: createAgentToolRuleSettingsMirror({
        opsRepository: runtime.ops,
        repositories: runtime.repositories,
        reloadRuntimeState: async () => {},
      }),
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
  });

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
      targetJid: 'tg:perm-durable-itest',
      toolName: 'Bash',
      toolInput: { command },
      // Same argv-leaf suggestion synthesis the host applies on the IPC path
      // (ipc-interaction-processing.ts sets request.suggestions from it).
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

  async function decideViaChannelCallback(
    request: PermissionApprovalRequest,
    mode: PermissionApprovalDecisionMode,
  ): Promise<void> {
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
    await expect(
      bindPendingPermissionInteractionMessage({
        request,
        decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
      }),
    ).resolves.toBe(true);
    const claimed = await claimPermissionInteractionCallback({
      scope: {
        appId: APP_ID,
        sourceAgentFolder: request.sourceAgentFolder,
        interactionId: request.requestId,
      },
      mode,
      approverRef: APPROVER,
      matchKind: 'individual',
    });
    if (claimed.status !== 'claimed') {
      throw new Error(`expected claimed, got ${claimed.status}`);
    }
    await expect(
      resolveDurablePermissionInteractionByRequestId({ claim: claimed.claim }),
    ).resolves.toBe(true);
  }

  async function interactionRow(requestId: string) {
    const rows = await runtime.service.db
      .select()
      .from(pgSchema.pendingInteractionsPostgres)
      .where(eq(pgSchema.pendingInteractionsPostgres.requestId, requestId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  /**
   * Restart simulation over the SAME schema with brand-new service +
   * repository instances (no in-memory state carried over), running the REAL
   * startup path: settings desired-state reconciliation exactly as
   * runStartup does for a 'file' settings authority (startup.ts →
   * SettingsDesiredStateService.reconcile →
   * desired-state-capability-reconcile.ts replaceDesiredStateCapabilities),
   * then the callback receives fresh repositories for the same deterministic
   * policy evaluation the autonomous gate runs
   * (tool-execution-policy-service.ts → evaluateAutonomousToolUse over
   * resolveConfiguredAllowedTools).
   */
  async function withRestartedServices<T>(
    fn: (
      repositories: PostgresIntegrationRuntime['repositories'],
    ) => Promise<T>,
  ): Promise<T> {
    const fresh = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL!,
      runtime.schemaName,
    );
    try {
      const repositories = createPostgresDomainRepositories(
        fresh.db,
        fresh.pool,
      );
      const ops = new PostgresRuntimeRepositoryBundle(fresh.pool, fresh.db, {
        runtimeEvents: new RuntimeEventExchange(
          repositories.runtimeEvents,
          new PostgresRuntimeEventNotifier(fresh.pool),
        ),
      });
      const settings = loadRuntimeSettings(GANTRY_HOME);
      const reconcile = await new SettingsDesiredStateService({
        ops,
        repositories,
      }).reconcile(settings);
      expect(reconcile.invalidReferences).toEqual([]);
      return await fn(repositories);
    } finally {
      await fresh.close();
    }
  }

  async function restartAndEvaluateGate(command: string, agentId = AGENT_ID) {
    return withRestartedServices(async (repositories) => {
      const rules = await resolveConfiguredAllowedTools({
        repository: repositories.tools,
        appId: APP_ID,
        agentId,
      });
      return evaluateAutonomousToolUse({
        rules: rules ?? [],
        toolName: 'Bash',
        toolInput: { command },
      });
    });
  }

  async function activeBindingsWithTools(agentId = AGENT_ID) {
    const bindings = await runtime.repositories.tools.listAgentToolBindings({
      appId: APP_ID as never,
      agentId: agentId as never,
    });
    return Promise.all(
      bindings
        .filter((binding) => binding.status === 'active')
        .map(async (binding) => ({
          binding,
          tool: await runtime.repositories.tools.getTool(binding.toolId),
        })),
    );
  }

  function settingsAgentRules(agentFolder: string): string[] {
    const agent = loadRuntimeSettings(GANTRY_HOME).agents[agentFolder];
    expect(agent).toBeDefined();
    return agent!.capabilities.map((capability) =>
      capabilityToToolRule(capability.id),
    );
  }

  it('allow_persistent_rule persists the exact argv-leaf rule via the settings mirror, auto-allows only that leaf for only that agent, and survives restart reconciliation', async () => {
    const command = '/usr/local/bin/report-status --daily';
    const request = makeRequest('req-perm-durable-future', command);
    const [expectedRule] = permissionUpdateAllowedToolRules(
      request.suggestions,
    );
    // The EXACT rule derived from the input command: a regression that widens
    // it (e.g. `RunCommand(/usr/local/bin/report-status *)`) fails here.
    expect(expectedRule).toBe(`RunCommand(${command})`);

    // Precondition: nothing allows this command before the decision, even
    // after a full restart reconciliation.
    expect((await restartAndEvaluateGate(command)).allowed).toBe(false);
    const activeToolIdsBefore = new Set(
      (await activeBindingsWithTools()).map(({ binding }) => binding.toolId),
    );

    await decideViaChannelCallback(request, 'allow_persistent_rule');

    // Durable rule persisted as an agent-scoped tool binding (CURRENT
    // semantics: binding identity is app+agent, not conversation). Exactly
    // one ACTIVE binding references the expected rule and it is new relative
    // to the pre-decision set — independent of whatever else is seeded.
    const boundTools = await activeBindingsWithTools();
    const ruleBindings = boundTools.filter(
      ({ tool }) => tool?.name === expectedRule,
    );
    expect(ruleBindings).toHaveLength(1);
    expect(activeToolIdsBefore.has(ruleBindings[0]!.binding.toolId)).toBe(
      false,
    );

    // The REAL settings mirror wrote desired state: the rule is now a
    // capability of the deciding agent in settings.yaml — and only of it.
    expect(settingsAgentRules(AGENT_FOLDER)).toContain(expectedRule);
    expect(settingsAgentRules(SECOND_AGENT_FOLDER)).not.toContain(expectedRule);

    // Fresh policy evaluation of the SAME command leaf auto-allows — the
    // deterministic gate matches the persisted rule, so no new prompt is
    // needed for this leaf.
    const rules = await resolveConfiguredAllowedTools({
      repository: runtime.repositories.tools,
      appId: APP_ID,
      agentId: AGENT_ID,
    });
    expect(rules).toContain(expectedRule);
    const evaluation = evaluateAutonomousToolUse({
      rules: rules ?? [],
      toolName: 'Bash',
      toolInput: { command },
    });
    expect(evaluation.allowed).toBe(true);

    // Argv-leaf scope: the SAME executable with different arguments is still
    // not allowed (the rule is not an executable-wide grant)...
    expect(
      evaluateAutonomousToolUse({
        rules: rules ?? [],
        toolName: 'Bash',
        toolInput: { command: '/usr/local/bin/report-status --monthly' },
      }).allowed,
    ).toBe(false);
    // ...and neither is a different executable.
    expect(
      evaluateAutonomousToolUse({
        rules: rules ?? [],
        toolName: 'Bash',
        toolInput: { command: '/usr/local/bin/other-tool --daily' },
      }).allowed,
    ).toBe(false);

    // Agent scope: the second configured agent does NOT see the rule
    // (guards the (appId, agentId) filter in tool-repository.postgres.ts).
    const secondAgentRules = await resolveConfiguredAllowedTools({
      repository: runtime.repositories.tools,
      appId: APP_ID,
      agentId: SECOND_AGENT_ID,
    });
    expect(secondAgentRules ?? []).not.toContain(expectedRule);
    expect(
      evaluateAutonomousToolUse({
        rules: secondAgentRules ?? [],
        toolName: 'Bash',
        toolInput: { command },
      }).allowed,
    ).toBe(false);

    // Durable interaction record resolved with the persistent decision.
    const row = await interactionRow(request.requestId);
    expect(row.status).toBe('resolved');
    expect(row.resolutionJson).toMatchObject({
      approved: true,
      mode: 'allow_persistent_rule',
    });
    expect(row.approverRef).toBe(APPROVER);

    // Permission decision audit row from the real grant path.
    const decisions = await runtime.service.db
      .select()
      .from(pgSchema.permissionDecisionsPostgres)
      .where(eq(pgSchema.permissionDecisionsPostgres.appId, APP_ID));
    const withContext = decisions.map((decision) => ({
      ...decision,
      actorContext: JSON.parse(decision.actorContextJson ?? 'null') as {
        requestId?: string;
      } | null,
    }));
    const granted = withContext.find(
      (decision) => decision.actorContext?.requestId === request.requestId,
    );
    expect(granted).toBeDefined();
    expect(granted!.effect).toBe('allow');
    expect(granted!.approverRef).toBe(APPROVER);
    expect(granted!.actorContext).toMatchObject({
      mode: 'allow_persistent_rule',
      classification: 'user_permanent',
    });

    // Restart: the REAL startup reconciliation replaces every agent's
    // bindings from authoritative settings.yaml, so this stays allowed ONLY
    // because the settings mirror durably wrote the rule (a DB-only binding
    // would have been wiped by the reconcile). The second agent still gets
    // nothing.
    expect((await restartAndEvaluateGate(command)).allowed).toBe(true);
    expect(
      (await restartAndEvaluateGate(command, SECOND_AGENT_ID)).allowed,
    ).toBe(false);
  }, 60_000);

  it('allow_once grants run-scoped transient authority under the active lease only, with no durable rule and nothing after restart', async () => {
    const command = '/usr/local/bin/send-digest --weekly';
    const runId = 'run-perm-durable-once';
    const workerId = 'worker-perm-durable-once';

    // Real run + claimed lease: the once-grant path
    // (pending-interaction-grants.ts applyPendingInteractionGrantDecision →
    // recordRunScopedTransientGrant) only issues authority against the
    // ACTIVE run lease.
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
      bootNonce: 'perm-durable-once',
    });
    const lease = await runtime.repositories.workerCoordination.claimRunLease({
      runId,
      workerInstanceId: workerId,
      ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();

    const request = makeRequest('req-perm-durable-once', command, {
      runId,
      leaseToken: lease!.leaseToken,
      fencingVersion: lease!.fencingVersion,
    });
    await decideViaChannelCallback(request, 'allow_once');

    const row = await interactionRow(request.requestId);
    expect(row.status).toBe('resolved');
    expect(row.resolutionJson).toMatchObject({
      approved: true,
      mode: 'allow_once',
    });

    // The once-authority is real and usable: a transient grant recorded
    // against the active lease, readable through the same lease-fenced read
    // model the runtime uses.
    const grants =
      await runtime.repositories.workerCoordination.listActiveTransientGrants({
        runId,
      });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.leaseToken).toBe(lease!.leaseToken);
    expect(grants[0]!.grant).toMatchObject({
      toolName: 'Bash',
      mode: 'allow_once',
      requestId: request.requestId,
    });

    // Once-only: no durable rule for this command leaf — not as an agent
    // tool binding, not in mirrored settings, and the deterministic gate
    // does not auto-allow it even while the transient grant is live.
    const boundTools = await activeBindingsWithTools();
    expect(
      boundTools.some(({ tool }) => tool?.name?.includes('send-digest')),
    ).toBe(false);
    expect(
      settingsAgentRules(AGENT_FOLDER).some((rule) =>
        rule.includes('send-digest'),
      ),
    ).toBe(false);
    const liveRules = await resolveConfiguredAllowedTools({
      repository: runtime.repositories.tools,
      appId: APP_ID,
      agentId: AGENT_ID,
    });
    expect(
      evaluateAutonomousToolUse({
        rules: liveRules ?? [],
        toolName: 'Bash',
        toolInput: { command },
      }).allowed,
    ).toBe(false);

    // The run ends (lease settles, as on worker shutdown/restart): the
    // transient grant is no longer readable from fresh service instances and
    // the durable gate still denies — once-authority did not outlive the run.
    await expect(
      runtime.repositories.workerCoordination.settleRunLease({
        runId,
        leaseToken: lease!.leaseToken,
        workerInstanceId: workerId,
        fencingVersion: lease!.fencingVersion,
        outcome: 'completed',
      }),
    ).resolves.toBe(true);
    await withRestartedServices(async (repositories) => {
      await expect(
        repositories.workerCoordination.listActiveTransientGrants({ runId }),
      ).resolves.toEqual([]);
    });
    expect((await restartAndEvaluateGate(command)).allowed).toBe(false);
  }, 60_000);

  it('cancel records the interaction as cancelled and persists no rule', async () => {
    const command = '/usr/local/bin/rotate-keys --now';
    const request = makeRequest('req-perm-durable-cancel', command);

    await decideViaChannelCallback(request, 'cancel');

    const row = await interactionRow(request.requestId);
    expect(row.status).toBe('cancelled');
    expect(row.resolutionJson).toMatchObject({
      approved: false,
      mode: 'cancel',
    });

    const boundTools = await activeBindingsWithTools();
    expect(
      boundTools.some(({ tool }) => tool?.name?.includes('rotate-keys')),
    ).toBe(false);
    expect(
      settingsAgentRules(AGENT_FOLDER).some((rule) =>
        rule.includes('rotate-keys'),
      ),
    ).toBe(false);
    expect((await restartAndEvaluateGate(command)).allowed).toBe(false);
  }, 60_000);
});
