import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresDomainRepositories } from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
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

// Uses the seeded default app/agent (seeds.ts) — no agent tool bindings exist
// at start, so the durable-rule assertions start from a clean policy.
const APP_ID = 'default';
const AGENT_ID = 'agent:main_agent';
const AGENT_FOLDER = 'main_agent';
const APPROVER = 'user:approver';

// Matrix §6 durable-authority chain, driven through the REAL channel
// button-resolution path: durable pending interaction → prompt binding →
// claim → resolveDurablePermissionInteractionByRequestId (the same functions
// the Slack/Telegram callback handlers invoke; see
// pending-interaction-permission-callback.ts). No decide-API is invented.
// Note: PERMISSION_* runtime events are published by the IPC processor
// (ipc-interaction-processing.ts), not by this decision-application path, so
// the durable evidence asserted here is rows: pending_interactions status +
// resolution, agent tool bindings, and permission_decisions.
maybeDescribe('permission durable authority chain (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  const mirroredRuleCalls: Array<{
    sourceAgentFolder: string;
    rules: string[];
    mode?: 'add' | 'remove';
  }> = [];

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'perm_durable',
    });
    configurePendingInteractionDurability({
      repository: runtime.repositories.workerCoordination,
    });
    configurePendingInteractionPermissionPersistence({
      opsRepository: runtime.ops,
      getToolRepository: () => runtime.repositories.tools,
      getPermissionRepository: () => runtime.repositories.permissions,
      mirrorAgentToolRulesToSettings: (sourceAgentFolder, rules, options) => {
        mirroredRuleCalls.push({
          sourceAgentFolder,
          rules: [...rules],
          ...(options?.mode ? { mode: options.mode } : {}),
        });
      },
    });
  }, 60_000);

  afterAll(async () => {
    configurePendingInteractionDurability(null);
    configurePendingInteractionPermissionPersistence(null);
    if (runtime) await runtime.cleanup();
  });

  function makeRequest(
    requestId: string,
    command: string,
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
   * Restart simulation: brand-new service + repository instances over the SAME
   * schema (no in-memory state carried over), then the same deterministic
   * policy evaluation the autonomous gate runs
   * (tool-execution-policy-service.ts → evaluateAutonomousToolUse over
   * resolveConfiguredAllowedTools).
   */
  async function evaluateGateWithFreshServices(command: string) {
    const fresh = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL!,
      runtime.schemaName,
    );
    try {
      const repositories = createPostgresDomainRepositories(
        fresh.db,
        fresh.pool,
      );
      const rules = await resolveConfiguredAllowedTools({
        repository: repositories.tools,
        appId: APP_ID,
        agentId: AGENT_ID,
      });
      return evaluateAutonomousToolUse({
        rules: rules ?? [],
        toolName: 'Bash',
        toolInput: { command },
      });
    } finally {
      await fresh.close();
    }
  }

  it('allow_persistent_rule persists an argv-leaf RunCommand rule that auto-allows the same leaf and survives restart', async () => {
    const command = '/usr/local/bin/report-status --daily';
    const request = makeRequest('req-perm-durable-future', command);
    const [expectedRule] = permissionUpdateAllowedToolRules(
      request.suggestions,
    );
    expect(expectedRule).toMatch(/^RunCommand\(/);

    // Precondition: nothing allows this command before the decision.
    const before = await evaluateGateWithFreshServices(command);
    expect(before.allowed).toBe(false);

    await decideViaChannelCallback(request, 'allow_persistent_rule');

    // Durable rule persisted as an agent-scoped tool binding (CURRENT
    // semantics: binding identity is app+agent, not conversation).
    const bindings = await runtime.repositories.tools.listAgentToolBindings({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
    });
    const activeBindings = bindings.filter(
      (binding) => binding.status === 'active',
    );
    expect(activeBindings).toHaveLength(1);
    const tool = await runtime.repositories.tools.getTool(
      activeBindings[0]!.toolId,
    );
    expect(tool?.name).toBe(expectedRule);
    expect(mirroredRuleCalls).toContainEqual({
      sourceAgentFolder: AGENT_FOLDER,
      rules: [expectedRule],
    });

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

    // A DIFFERENT command leaf is still not allowed (argv-leaf scope, not a
    // command-name class).
    expect(
      evaluateAutonomousToolUse({
        rules: rules ?? [],
        toolName: 'Bash',
        toolInput: { command: '/usr/local/bin/other-tool --daily' },
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

    // Restart simulation: new service + repository instances, same database —
    // the rule is still effective.
    const afterRestart = await evaluateGateWithFreshServices(command);
    expect(afterRestart.allowed).toBe(true);
  });

  it('allow_once resolves the interaction without persisting any durable rule', async () => {
    const command = '/usr/local/bin/send-digest --weekly';
    const request = makeRequest('req-perm-durable-once', command);

    await decideViaChannelCallback(request, 'allow_once');

    const row = await interactionRow(request.requestId);
    expect(row.status).toBe('resolved');
    expect(row.resolutionJson).toMatchObject({
      approved: true,
      mode: 'allow_once',
    });

    // No durable rule for this command leaf: only the allow_persistent_rule
    // binding from the previous case may exist.
    const bindings = await runtime.repositories.tools.listAgentToolBindings({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
    });
    const tools = await Promise.all(
      bindings
        .filter((binding) => binding.status === 'active')
        .map((binding) => runtime.repositories.tools.getTool(binding.toolId)),
    );
    expect(tools.some((tool) => tool?.name?.includes('send-digest'))).toBe(
      false,
    );

    // No run-scoped transient grant either (no runId on this request).
    const grants = await runtime.service.db
      .select()
      .from(pgSchema.transientGrantsPostgres);
    expect(grants).toHaveLength(0);

    // Restart simulation: transient authority is gone — a fresh policy
    // evaluation of the same command does NOT auto-allow.
    const afterRestart = await evaluateGateWithFreshServices(command);
    expect(afterRestart.allowed).toBe(false);
  });

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

    const bindings = await runtime.repositories.tools.listAgentToolBindings({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
    });
    const tools = await Promise.all(
      bindings
        .filter((binding) => binding.status === 'active')
        .map((binding) => runtime.repositories.tools.getTool(binding.toolId)),
    );
    expect(tools.some((tool) => tool?.name?.includes('rotate-keys'))).toBe(
      false,
    );
    const afterRestart = await evaluateGateWithFreshServices(command);
    expect(afterRestart.allowed).toBe(false);
  });
});
