import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_ENGINE } from '../../src/shared/agent-engine.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const configMocks = vi.hoisted(() => ({ schedulerDatabaseUrl: '' }));
const pgBossMocks = vi.hoisted(() => ({ schema: '' }));

vi.mock('pg-boss', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg-boss')>();

  class IsolatedPgBoss extends actual.PgBoss {
    constructor(options: string | import('pg-boss').ConstructorOptions) {
      super(
        typeof options === 'string'
          ? { connectionString: options, schema: pgBossMocks.schema }
          : { ...options, schema: pgBossMocks.schema },
      );
    }
  }

  return { ...actual, PgBoss: IsolatedPgBoss };
});

vi.mock('@core/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/config/index.js')>();
  return {
    ...actual,
    get STORAGE_POSTGRES_URL() {
      return configMocks.schedulerDatabaseUrl;
    },
  };
});

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import {
  buildJobListVisibilityMetadata,
  buildJobVisibilityMetadata,
} from '@core/application/jobs/job-visibility-metadata.js';
import { applyPermissionInteractionDecision } from '@core/application/interactions/pending-interaction-durability.js';
import {
  configurePendingInteractionDurability,
  configurePendingInteractionPermissionPersistence,
} from '@core/application/interactions/pending-interaction-durability.js';
import {
  configureSetupPausePermissionPrompt,
  type SetupPausePermissionPromptDeps,
} from '@core/application/jobs/setup-pause-permission-prompt.js';
import {
  appendSetupPauseRequirementAfterPersistentGrant,
  setupPausePersistentGrantIsCurrent,
} from '@core/app/bootstrap/setup-pause-permission-wiring.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import type {
  ConversationRoute,
  JobRun,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '@core/domain/types.js';
import { PgBossSchedulerEngine } from '@core/infrastructure/pgboss/scheduler-engine.js';
import { configureRunSlotBackend } from '@core/jobs/concurrency.js';
import { _resetSchedulerLoopForTests, runJob } from '@core/jobs/scheduler.js';
import {
  requestPermissionReviewSuggestions,
  requestPermissionSetupDecisionOptions,
} from '@core/jobs/request-permission-review.js';
import { registerWorkerInstance } from '@core/jobs/worker-identity.js';
import {
  recordCapabilityTemplateAmendment,
  startCapabilityTemplateAmendmentReview,
} from '@core/jobs/ipc-capability-template-amendment.js';
import { runStructuredLocalCliCapability } from '@core/jobs/structured-local-cli-invocation.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import {
  buildLocalCliSemanticCapability,
  semanticCapabilityFromToolCatalogItem,
  semanticCapabilityInputSchema,
} from '@core/shared/semantic-capabilities.js';
import { registerWorkerPermissionRunRestriction } from '@core/runtime/agent-spawn-permission-run-restriction.js';
import type { AgentOutput } from '@core/runtime/agent-spawn.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import { unregisterPermissionRunRestriction } from '@core/runtime/permission-decision-coordinator.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import { createRuntimeFlowHarness } from '../harness/runtime-flow-harness.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const now = '2026-07-21T00:00:00.000Z';

function makeJob(id: string, patch: Partial<JobUpsertInput> = {}) {
  return {
    id,
    name: `Job ${id}`,
    prompt: 'Run the deterministic lifecycle test',
    schedule_type: 'interval',
    schedule_value: '60000',
    status: 'active',
    session_id: null,
    thread_id: 'thread-job-lifecycle',
    execution_context: {
      conversationJid: 'tg:job-lifecycle',
      threadId: 'thread-job-lifecycle',
      workspaceKey: 'job_lifecycle_agent',
      sessionId: null,
    },
    notification_routes: [
      {
        conversationJid: 'tg:job-lifecycle',
        threadId: 'thread-job-lifecycle',
        label: 'primary',
      },
    ],
    workspace_key: 'job_lifecycle_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: now,
    silent: true,
    timeout_ms: 30_000,
    max_retries: 3,
    retry_backoff_ms: 1,
    max_consecutive_failures: 5,
    ...patch,
  } satisfies JobUpsertInput;
}

function makeRun(
  jobId: string,
  runId: string,
  patch: Partial<JobRun> = {},
): JobRun {
  return {
    run_id: runId,
    job_id: jobId,
    execution_provider_id: 'anthropic:claude-agent-sdk',
    scheduled_for: now,
    started_at: now,
    ended_at: now,
    status: 'completed',
    result_summary: 'completed',
    error_summary: null,
    retry_count: 0,
    notified_at: null,
    ...patch,
  };
}

function makeConversationRoute(): ConversationRoute {
  return {
    name: 'Job Lifecycle Agent',
    folder: 'job_lifecycle_agent',
    trigger: '',
    added_at: now,
    requiresTrigger: false,
    conversationKind: 'channel',
  };
}

maybeDescribe('job lifecycle (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let schedulerEngine: PgBossSchedulerEngine | undefined;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'job_lifecycle',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    configMocks.schedulerDatabaseUrl = process.env.GANTRY_TEST_DATABASE_URL!;
    pgBossMocks.schema = `pgboss_job_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  }, 60_000);

  afterAll(async () => {
    await schedulerEngine?.stop();
    try {
      await runtime.service.pool.query(
        `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(pgBossMocks.schema)} CASCADE`,
      );
    } finally {
      await runtime.cleanup();
    }
  });

  beforeEach(async () => {
    _resetSchedulerLoopForTests();
    const workerInstanceId = await registerWorkerInstance(
      runtime.repositories.workerCoordination,
    );
    configureRunSlotBackend({
      repository: runtime.repositories.workerCoordination,
      workerInstanceId,
    });
  });

  afterEach(async () => {
    configureSetupPausePermissionPrompt(null);
    configurePendingInteractionDurability(null);
    configurePendingInteractionPermissionPersistence(null);
    await schedulerEngine?.stop();
    schedulerEngine = undefined;
  });

  it('CAPFIX-1-2 mismatch proposal card approval amends resumes and runs structured argv', async () => {
    // The fixture executable must live OUTSIDE the agent-writable workspace
    // root (which realpaths under os.tmpdir() in this harness): CLIRUN-1's
    // executable-identity guard rejects workspace-local binaries by design.
    const executableDir = fs.mkdtempSync(
      path.join(os.homedir(), '.gantry-capfix-exec-'),
    );
    fs.chmodSync(executableDir, 0o755);
    const executable = path.join(executableDir, 'gog');
    const executableBody = '#!/bin/sh\nexit 0\n';
    fs.writeFileSync(executable, executableBody, { mode: 0o755 });
    const executableHash = `sha256:${createHash('sha256')
      .update(executableBody)
      .digest('hex')}`;
    const capabilityId = `google.sheets.values.get.${randomUUID()}`;
    const agentId = `agent:job_lifecycle_agent` as never;
    const toolId = `tool:capability:${capabilityId}` as never;
    const capability = buildLocalCliSemanticCapability({
      capabilityId,
      displayName: 'Google Sheets lead reader',
      category: 'Google Sheets',
      risk: 'read',
      can: 'read lead rows from the selected sheet',
      cannot: 'change unrelated sheets',
      executablePath: executable,
      executableVersion: '1.0.0',
      executableHash,
      commandTemplates: [`${executable} sheets get *`],
      authPreflightCommand: `${executable} auth status`,
    });
    const job = makeJob(`job:integration:capfix:${randomUUID()}`, {
      status: 'paused',
      next_run: null,
      pause_reason: 'Setup required',
      access_requirements: [
        {
          target: {
            kind: 'tool_rule',
            rule: `capability:${capabilityId}`,
          },
        },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: now,
        fingerprint: 'capfix-blocked',
        notified_fingerprint: null,
        blockers: [
          {
            state: 'missing_capability',
            type: 'semantic_capability',
            id: `capability:${capabilityId}`,
            summary: 'Capability template mismatch blocks this job.',
            action: {
              kind: 'instruction',
              text: 'Approve the capability fix proposal to continue.',
            },
          },
        ],
      },
    });

    try {
      await runtime.repositories.agents.saveAgent({
        id: agentId,
        appId: 'default' as never,
        name: 'Job Lifecycle Agent',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await runtime.repositories.tools.saveTool({
        id: toolId,
        appId: 'default' as never,
        name: `capability:${capabilityId}`,
        kind: 'host',
        provider: 'gantry',
        displayName: capability.displayName,
        category: 'productivity',
        risk: 'high',
        selectable: true,
        status: 'active',
        adapterRef: `capability/${capabilityId}`,
        inputSchema: semanticCapabilityInputSchema(capability),
        createdAt: now,
        updatedAt: now,
      });
      await runtime.repositories.tools.saveAgentToolBinding({
        id: `binding:${capabilityId}` as never,
        appId: 'default' as never,
        agentId,
        toolId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await runtime.ops.upsertJob(job);

      const invoke = () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = 999_998;
        child.kill = () => true;
        const started = new Promise<void>((resolve) => {
          child.once('spawn', resolve);
        });
        const result = runStructuredLocalCliCapability({
          repository: runtime.repositories.tools,
          appId: 'default',
          agentId,
          capabilityId,
          args: ['sheets', 'get', 'sheet-1', 'Leads!A:B'],
          // cwd doubles as the agent-writable root in the executable-identity
          // guard — it must NOT contain the fixture executable.
          cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-capfix-cwd-')),
          env: { PATH: '/usr/bin', HOME: os.homedir() },
          runnerSandboxProvider: {
            id: 'capfix-test-sandbox',
            enforcing: true,
            start: () => {
              queueMicrotask(() => child.emit('spawn'));
              return child as never;
            },
          },
          signal: new AbortController().signal,
          conversationId: 'tg:job-lifecycle',
          jobId: job.id,
        });
        return { child, started, result };
      };

      await expect(invoke().result).rejects.toMatchObject({
        code: 'capability_template_mismatch',
      });
      const proposedTemplates = [`${executable} sheets get * *`];
      const recorded = await recordCapabilityTemplateAmendment({
        appId: 'default',
        agentId,
        requestedBy: 'job_lifecycle_agent',
        jobId: job.id,
        conversationJid: 'tg:job-lifecycle',
        threadId: 'thread-job-lifecycle',
        capabilityId,
        proposedTemplates,
        observedArgv: [executable, 'sheets', 'get', 'sheet-1', 'Leads!A:B'],
        toolRepository: runtime.repositories.tools,
        proposalRepository: runtime.repositories.capabilityTemplateAmendments,
        now,
      });
      expect(recorded).toMatchObject({
        ok: true,
        code: 'capability_amendment_proposal_recorded',
      });
      if (!recorded.ok || !recorded.review) {
        throw new Error('Expected a recorded amendment review.');
      }

      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const requestPermissionApproval = vi.fn(
        async (request: PermissionApprovalRequest) => {
          expect(request.interaction?.body).not.toMatch(
            /gog|Observed argv|sha256|capabilityId/i,
          );
          expect(request.toolInput?.diffPreview).toContain(
            proposedTemplates[0],
          );
          return {
            kind: 'decision' as const,
            decision: {
              approved: true,
              mode: 'allow_once' as const,
              decidedBy: 'person:ravi',
              decisionClassification: 'user_once' as const,
            },
          };
        },
      );
      const sendMessage = vi.fn(async (_jid: string, text: string) => {
        if (text.startsWith('Approved the fix')) finish();
      });
      startCapabilityTemplateAmendmentReview({
        deps: {
          requestPermissionApproval,
          sendMessage,
          opsRepository: runtime.ops,
          onSchedulerChanged: vi.fn(),
          getToolRepository: () => runtime.repositories.tools,
        } as never,
        repository: runtime.repositories.capabilityTemplateAmendments,
        review: recorded.review,
      });
      await finished;

      const updatedTool = await runtime.repositories.tools.getTool(toolId);
      const updatedCapability = semanticCapabilityFromToolCatalogItem({
        name: updatedTool?.name,
        inputSchema: updatedTool?.inputSchema,
      });
      expect(updatedCapability?.implementationBindings[0]).toMatchObject({
        executablePath: executable,
        executableHash,
        executableVersion: '1.0.0',
        // Amendments ADD reviewed forms; the previously approved template
        // survives alongside the new one.
        commandTemplates: [`${executable} sheets get *`, ...proposedTemplates],
      });
      const history = await runtime.service.pool.query<{
        prior_templates: string[];
        amended_templates: string[];
        approved_by: string;
        audit_event_id: string;
      }>(
        'select prior_templates, amended_templates, approved_by, audit_event_id from capability_template_amendment_history where proposal_id = $1',
        [recorded.review.proposal.id],
      );
      expect(history.rows[0]).toMatchObject({
        prior_templates: [`${executable} sheets get *`],
        amended_templates: [`${executable} sheets get *`, ...proposedTemplates],
        approved_by: 'person:ravi',
      });
      const audit = await runtime.service.pool.query(
        'select id from permission_audit_events where id = $1',
        [history.rows[0]!.audit_event_id],
      );
      expect(audit.rows).toHaveLength(1);
      expect((await runtime.ops.getJobById(job.id))?.status).toBe('active');
      await expect(
        runtime.repositories.capabilityTemplateAmendments.amendSemanticCapabilityCommandTemplates(
          {
            proposalId: recorded.review.proposal.id,
            appId: 'default',
            capabilityId,
            expectedReviewedSchemaHash:
              recorded.review.proposal.reviewedSchemaHash,
            proposedTemplates,
            approvedBy: 'person:ravi',
            approvedAt: now,
          },
        ),
      ).resolves.toEqual({ status: 'already_amended' });

      const invocation = invoke();
      await invocation.started;
      invocation.child.emit('close', 0, null);
      // Empty stdout maps to the runner's success sentinel
      // (async-command-sandbox-runner outputSummary fallback).
      await expect(invocation.result).resolves.toEqual({
        stdout: 'command completed',
        stderr: '',
      });

      const deniedTemplates = [`${executable} sheets get * * *`];
      const denied = await recordCapabilityTemplateAmendment({
        appId: 'default',
        agentId,
        requestedBy: 'job_lifecycle_agent',
        conversationJid: 'tg:job-lifecycle',
        capabilityId,
        proposedTemplates: deniedTemplates,
        observedArgv: [
          executable,
          'sheets',
          'get',
          'sheet-1',
          'Leads!A:B',
          'extra',
        ],
        toolRepository: runtime.repositories.tools,
        proposalRepository: runtime.repositories.capabilityTemplateAmendments,
        now,
      });
      if (!denied.ok || !denied.review) {
        throw new Error('Expected a denyable amendment review.');
      }
      let deniedFinish!: () => void;
      const deniedFinished = new Promise<void>((resolve) => {
        deniedFinish = resolve;
      });
      const deniedApproval = vi.fn(async () => ({
        kind: 'decision' as const,
        decision: {
          approved: false,
          mode: 'cancel' as const,
          decidedBy: 'person:ravi',
          reason: 'Keep the current reviewed shape.',
          decisionClassification: 'user_reject' as const,
        },
      }));
      startCapabilityTemplateAmendmentReview({
        deps: {
          requestPermissionApproval: deniedApproval,
          sendMessage: vi.fn(async (_jid: string, text: string) => {
            if (text.startsWith('Denied the fix')) deniedFinish();
          }),
        } as never,
        repository: runtime.repositories.capabilityTemplateAmendments,
        review: denied.review,
      });
      await deniedFinished;
      const deniedAgain = await recordCapabilityTemplateAmendment({
        appId: 'default',
        agentId,
        requestedBy: 'job_lifecycle_agent',
        conversationJid: 'tg:job-lifecycle',
        capabilityId,
        proposedTemplates: deniedTemplates,
        observedArgv: [
          executable,
          'sheets',
          'get',
          'sheet-1',
          'Leads!A:B',
          'extra',
        ],
        toolRepository: runtime.repositories.tools,
        proposalRepository: runtime.repositories.capabilityTemplateAmendments,
        now,
      });
      expect(deniedAgain).toMatchObject({
        ok: true,
        code: 'capability_amendment_proposal_previously_denied',
      });
      expect(deniedAgain.ok && deniedAgain.review).toBeUndefined();
      expect(deniedApproval).toHaveBeenCalledTimes(1);
      const afterDeny = semanticCapabilityFromToolCatalogItem({
        inputSchema: (await runtime.repositories.tools.getTool(toolId))
          ?.inputSchema,
      });
      expect(afterDeny?.implementationBindings[0]?.commandTemplates).toEqual([
        `${executable} sheets get *`,
        ...proposedTemplates,
      ]);
    } finally {
      fs.rmSync(executableDir, { recursive: true, force: true });
      // Shared-schema hygiene: later tests enumerate jobs and resolve the
      // shared agent's tool policy — leave neither the job nor the binding.
      await runtime.ops.deleteJob(job.id).catch(() => undefined);
      await runtime.repositories.tools
        .saveAgentToolBinding({
          id: `binding:${capabilityId}` as never,
          appId: 'default' as never,
          agentId,
          toolId,
          status: 'removed',
          createdAt: now,
          updatedAt: now,
        })
        .catch(() => undefined);
    }
  }, 60_000);

  it('projects one latest non-session run for a 500-job listing in one query', async () => {
    const jobs = Array.from({ length: 500 }, (_, index) =>
      makeJob(`job:integration:latest-run:${index}`, {
        status: 'paused',
        next_run: null,
      }),
    );
    await Promise.all(jobs.map((job) => runtime.ops.upsertJob(job)));

    const baseRuns = jobs.slice(1).map((job, index) => {
      const status = (['running', 'completed', 'failed'] as const)[
        Math.min(index, 2)
      ];
      return makeRun(job.id, `run:integration:latest-run:${index + 1}`, {
        scheduled_for: `2026-07-21T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        started_at: `2026-07-21T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        ended_at: status === 'running' ? null : now,
        status,
        result_summary: status === 'failed' ? null : status,
        error_summary: status === 'failed' ? 'planned failure' : null,
      });
    });
    await Promise.all(baseRuns.map((run) => runtime.ops.createJobRun(run)));

    const nullStartedJob = jobs[4]!;
    const nullStartedRun = makeRun(
      nullStartedJob.id,
      'run:integration:latest-run:null-started',
      {
        scheduled_for: '2026-07-21T01:00:00.000Z',
        started_at: '2026-07-21T01:00:00.000Z',
        result_summary: 'newer creation with null start',
      },
    );
    await runtime.ops.createJobRun(nullStartedRun);
    await runtime.service.db
      .update(pgSchema.agentRunsPostgres)
      .set({ startedAt: null })
      .where(eq(pgSchema.agentRunsPostgres.id, nullStartedRun.run_id));

    const sessionExcludedJob = jobs[5]!;
    const sessionRun = makeRun(
      sessionExcludedJob.id,
      'run:integration:latest-run:session',
      {
        scheduled_for: '2026-07-21T02:00:00.000Z',
        started_at: '2026-07-21T02:00:00.000Z',
        result_summary: 'session run must be excluded',
      },
    );
    await runtime.ops.createJobRun(sessionRun);
    const jobOwner = await runtime.service.db
      .select({
        appId: pgSchema.agentRunsPostgres.appId,
        agentId: pgSchema.agentRunsPostgres.agentId,
      })
      .from(pgSchema.agentRunsPostgres)
      .where(eq(pgSchema.agentRunsPostgres.id, sessionRun.run_id))
      .limit(1);
    await runtime.repositories.agentSessions.saveAgentSession({
      id: 'agent-session:latest-run-projection' as never,
      appId: jobOwner[0]!.appId as never,
      agentId: jobOwner[0]!.agentId as never,
      status: 'active',
      createdAt: now as never,
      updatedAt: now as never,
    });
    await runtime.service.db
      .update(pgSchema.agentRunsPostgres)
      .set({ sessionId: 'agent-session:latest-run-projection' })
      .where(eq(pgSchema.agentRunsPostgres.id, sessionRun.run_id));

    const equivalenceJobs = jobs.slice(0, 6);
    const perJobMetadata = new Map(
      await Promise.all(
        equivalenceJobs.map(async (job) => [
          job.id,
          await buildJobVisibilityMetadata({
            job: (await runtime.ops.getJobById(job.id))!,
            ops: runtime.ops,
          }),
        ]),
      ),
    );
    const querySpy = vi.spyOn(runtime.service.pool, 'query');
    querySpy.mockClear();

    const listMetadata = await buildJobListVisibilityMetadata({
      jobs: await runtime.ops.listJobs({
        limit: 500,
      }),
      ops: runtime.ops,
    });

    // Five CONSTANT queries for a 500-job listing: jobs, latest runs, the
    // batched first-denial-per-run read (0126), the windowed per-job setup
    // delivery-notice read, and the latest-prompt-per-job read (S3) -
    // never an N+1 per job.
    expect(querySpy).toHaveBeenCalledTimes(5);
    expect(
      querySpy.mock.calls.filter(([query]) =>
        String(
          typeof query === 'string' ? query : (query as { text?: string }).text,
        ).includes('distinct on'),
      ),
    ).toHaveLength(4);
    querySpy.mockRestore();
    for (const job of equivalenceJobs) {
      expect(listMetadata.get(job.id)).toMatchObject({
        health: perJobMetadata.get(job.id)!.health,
        staleness: perJobMetadata.get(job.id)!.staleness,
        recentRunErrors: perJobMetadata.get(job.id)!.recentRunErrors,
      });
    }
    expect(listMetadata.get(nullStartedJob.id)?.health.latestRunId).toBe(
      baseRuns[3]!.run_id,
    );
    expect(listMetadata.get(sessionExcludedJob.id)?.health.latestRunId).toBe(
      baseRuns[4]!.run_id,
    );
  }, 60_000);

  it('exhausts retries into dead-letter with terminal runtime evidence', async () => {
    const harness = createRuntimeFlowHarness({
      runnerResult: {
        status: 'error',
        error: 'planned retry exhaustion',
      },
    });
    const job = makeJob('job:integration:retry-exhaustion', {
      max_retries: 1,
      max_consecutive_failures: 99,
      next_run: new Date(Date.now() - 1_000).toISOString(),
    });
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const deps = {
      processRole: 'all' as const,
      hasLiveAdmissionBacklog: async () => false,
      conversationRoutes: () => ({
        'tg:job-lifecycle': makeConversationRoute(),
      }),
      queue: {} as never,
      onProcess: () => {},
      sendMessage: harness.channel.sendMessage,
      opsRepository: runtime.ops,
      runAgent: harness.runner.runAgent as never,
      runnerSandboxProvider: {} as never,
      onSchedulerChanged: (jobId?: string) => {
        if (jobId === job.id && harness.runner.calls.length >= 2) {
          resolveTerminal();
        }
      },
    };
    await runtime.ops.upsertJob(job);
    schedulerEngine = new PgBossSchedulerEngine(deps, {
      registerSystemJobs: async () => undefined,
      runJob,
      sweepCompletedOneTimeJobs: async () => false,
    });
    await schedulerEngine.start();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        terminal,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('scheduler did not exhaust retries')),
            30_000,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const runs = await runtime.ops.listJobRuns(job.id);
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.status === 'failed')).toHaveLength(1);
    expect(runs.filter((run) => run.status === 'dead_lettered')).toHaveLength(
      1,
    );
    expect(runs.every((run) => run.ended_at !== null)).toBe(true);
    expect(runs.some((run) => run.status === 'running')).toBe(false);
    const leases = await runtime.service.pool.query<{
      run_id: string;
      status: string;
    }>(
      `SELECT run_id, status
         FROM ${quotePostgresIdentifier(runtime.schemaName)}.run_leases
        WHERE run_id = ANY($1::text[])
        ORDER BY run_id`,
      [runs.map((run) => run.run_id)],
    );
    expect(leases.rows).toHaveLength(2);
    expect(leases.rows.every((lease) => lease.status === 'failed')).toBe(true);

    const deadLetterRun = runs.find((run) => run.status === 'dead_lettered')!;
    await expect(runtime.ops.listDeadLetterRuns()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: deadLetterRun.run_id,
          job_id: job.id,
          status: 'dead_lettered',
        }),
      ]),
    );
    await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
      status: 'dead_lettered',
      consecutive_failures: 2,
      next_run: null,
      lease_run_id: null,
      lease_expires_at: null,
    });

    const events = await runtime.ops.listRecentJobEvents(20, {
      job_id: job.id,
      run_id: deadLetterRun.run_id,
    });
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        'run.dead_lettered',
        'job.failed',
        'job.run.failed',
      ]),
    );
    const terminalEvent = events.find(
      (event) => event.event_type === 'job.run.failed',
    );
    expect(JSON.parse(terminalEvent?.payload ?? '{}')).toMatchObject({
      status: 'dead_lettered',
    });
  });

  it('AUTODET-1-2 > deny pause grant resume complete loop with no auto_classifier provenance', async () => {
    const harness = createRuntimeFlowHarness();
    const job = makeJob('job:integration:autodet-fix-and-continue', {
      silent: false,
    });
    const command = 'npm test -- unit';
    const recoveryAction = `request_access ${JSON.stringify({
      target: { kind: 'run_command', argvPattern: command },
      temporaryOnly: false,
      reason: 'Approve exact command access, then resume the job.',
    })}`;
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      risk_category: 'benign' as const,
      reason: 'Classifier would allow this command.',
      latencyMs: 1,
    }));
    const requestPermissionApproval = vi.fn();
    const decisions: Array<{
      runId: string;
      decision: PermissionApprovalDecision;
    }> = [];
    const runnerInputs: Record<string, unknown>[] = [];
    let setupRequest: PermissionApprovalRequest | undefined;
    configurePendingInteractionDurability({
      repository: runtime.repositories.workerCoordination,
      warn: vi.fn(),
    });
    configurePendingInteractionPermissionPersistence({
      opsRepository: runtime.ops,
      beforePersistentGrant: (request, updates) =>
        setupPausePersistentGrantIsCurrent(runtime.ops, request, updates),
      afterPersistentGrant: (request, updates) =>
        appendSetupPauseRequirementAfterPersistentGrant(
          runtime.ops,
          request,
          updates,
        ),
      getToolRepository: () => runtime.repositories.tools,
      getPermissionRepository: () => runtime.repositories.permissions,
      mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
      onSchedulerChanged: vi.fn(),
      publishRuntimeEvent: (event) =>
        runtime.storageRuntime.runtimeEvents
          .publish(event)
          .then(() => undefined),
    });
    // Post-activation contract: setup pause ENQUEUES the card through the
    // composite preparation and returns immediately - the decision arrives
    // later through the durable callback path, simulated below with
    // applyPermissionInteractionDecision.
    const preparePermissionInteraction = vi.fn<
      SetupPausePermissionPromptDeps['preparePermissionInteraction']
    >(async (request) => {
      setupRequest = request;
      return { created: true };
    });
    configureSetupPausePermissionPrompt({
      appId: 'default',
      getJobById: async (jobId) =>
        (await runtime.ops.getJobById(jobId)) ?? undefined,
      preparePermissionInteraction,
      cancelPermissionApproval: async () => 'not_found',
      reviewStoredRequirement: async ({ toolInput }) => {
        const suggestions = requestPermissionReviewSuggestions(toolInput);
        return suggestions?.length
          ? {
              suggestions,
              decisionOptions: requestPermissionSetupDecisionOptions(toolInput),
            }
          : null;
      },
    });

    const resolveHostDecision = async (input: Record<string, unknown>) => {
      const responseKeyId = `autodet-${randomUUID()}`;
      const runId = String(input.runId);
      registerWorkerPermissionRunRestriction({
        sourceAgentFolder: job.workspace_key,
        responseKeyId,
        hideAuthorityTools: false,
        runKind: 'scheduled',
        jobId: job.id,
        runId,
      });
      try {
        return await resolvePermissionIpcDecision({
          request: {
            requestId: `permission-${randomUUID()}`,
            responseKeyId,
            sourceAgentFolder: job.workspace_key,
            appId: 'default',
            agentId: String(input.agentId),
            runId,
            jobId: job.id,
            targetJid: 'tg:job-lifecycle',
            threadId: 'thread-job-lifecycle',
            toolName: 'RunCommand',
            toolInput: { command },
            unattended: true,
            decisionReason:
              'Worker matcher found no matching allowedTools rule.',
          },
          sourceAgentFolder: job.workspace_key,
          deps: {
            conversationRoutes: () => ({}),
            requestPermissionApproval,
            classifierConsult,
            publishRuntimeEvent: (event) =>
              runtime.storageRuntime.runtimeEvents
                .publish(event)
                .then(() => undefined),
            getToolRepository: () => runtime.repositories.tools,
            getPermissionRuntimeSettings: () => ({
              agents: {
                [job.workspace_key]: {
                  permissionMode: 'auto' as const,
                  capabilities: [],
                },
              },
              permissions: {
                autoMode: {},
                trustedRoots: [resolveWorkspaceFolderPath(job.workspace_key)],
              },
              memory: { llm: { models: { extractor: 'sonnet' } } },
            }),
          } as never,
        });
      } finally {
        unregisterPermissionRunRestriction({
          sourceAgentFolder: job.workspace_key,
          responseKeyId,
        });
      }
    };

    const runAgent = async (
      _group: ConversationRoute,
      input: Record<string, unknown>,
      _onProcess: unknown,
      onOutput?: (output: AgentOutput) => void | Promise<void>,
    ): Promise<AgentOutput> => {
      runnerInputs.push(input);
      const decision = await resolveHostDecision(input);
      decisions.push({ runId: String(input.runId), decision });
      if (decision.approved) {
        await onOutput?.({
          status: 'success',
          result: null,
          runtimeEvents: [
            {
              appId: String(input.appId),
              agentId: String(input.agentId),
              runId: String(input.runId),
              jobId: job.id,
              conversationId: 'tg:job-lifecycle',
              threadId: 'thread-job-lifecycle',
              eventType: 'job.tool_activity',
              actor: 'runner',
              responseMode: 'none',
              payload: {
                phase: 'permission_allowed',
                tool: 'RunCommand',
                mode: decision.mode,
                decided_by: decision.decidedBy,
                source: decision.source,
                repeatableForFutureRuns: decision.repeatableForFutureRuns,
                reason: decision.reason,
              },
            },
          ],
        });
        return { status: 'success', result: 'command completed' };
      }
      await onOutput?.({
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            appId: String(input.appId),
            agentId: String(input.agentId),
            runId: String(input.runId),
            jobId: job.id,
            conversationId: 'tg:job-lifecycle',
            threadId: 'thread-job-lifecycle',
            eventType: 'job.tool_activity',
            actor: 'runner',
            responseMode: 'none',
            payload: {
              phase: 'permission_wait',
              tool: 'RunCommand',
              reason: decision.reason,
              recovery_action: recoveryAction,
            },
          },
          {
            appId: String(input.appId),
            agentId: String(input.agentId),
            runId: String(input.runId),
            jobId: job.id,
            conversationId: 'tg:job-lifecycle',
            threadId: 'thread-job-lifecycle',
            eventType: 'job.tool_activity',
            actor: 'runner',
            responseMode: 'none',
            payload: {
              phase: 'permission_denied',
              tool: 'RunCommand',
              terminal: true,
              action: {
                kind: 'approve_grant',
                grant: {
                  type: 'addRules',
                  behavior: 'allow',
                  rules: [
                    { tool_name: 'RunCommand', rule_content: 'npm test *' },
                  ],
                },
              },
              decided_by: decision.decidedBy,
              source: decision.source,
              reason: decision.reason,
              denial_kind: 'permission_denied',
              provenance_lane: DEFAULT_AGENT_ENGINE,
              provenance_seam: 'gate',
            },
          },
        ],
      });
      return {
        status: 'error',
        error: `Permission denied for RunCommand. ${decision.reason ?? 'Permission denied.'}`,
      };
    };
    await runtime.ops.upsertJob(job);
    const deps = {
      conversationRoutes: () => ({
        'tg:job-lifecycle': makeConversationRoute(),
      }),
      queue: {} as never,
      onProcess: () => {},
      sendMessage: harness.channel.sendMessage,
      opsRepository: runtime.ops,
      runAgent: runAgent as never,
      runnerSandboxProvider: {} as never,
      // Readiness preflight resolves the job tool policy through this hook;
      // without it the granted binding is invisible and the rerun re-pauses.
      getToolRepository: () => runtime.repositories.tools,
    };

    await runJob(
      (await runtime.ops.getJobById(job.id))!,
      deps,
      'tg:job-lifecycle',
    );

    expect(runnerInputs).toHaveLength(1);
    expect(runnerInputs[0]).toMatchObject({
      isScheduledJob: true,
      jobId: job.id,
      toolPolicyRules: [],
    });
    expect(decisions[0]?.decision).toMatchObject({
      approved: false,
      mode: 'cancel',
      decidedBy: 'deterministic_rails',
      reason:
        'Autonomous runs decide deterministically: RunCommand has no declared grant.',
    });
    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(preparePermissionInteraction).toHaveBeenCalledOnce();
    expect(setupRequest).toMatchObject({
      jobId: job.id,
      toolName: 'request_permission',
      decisionOptions: ['allow_persistent_rule', 'cancel'],
      suggestions: [
        // S2b typed grant: the durable suggestion carries the reviewed
        // prefix scope (persistentAutonomousBashRecoveryRule), not the
        // transient exact argv.
        expect.objectContaining({
          type: 'addRules',
          behavior: 'allow',
          // SDK suggestion shape stays camelCase with session destination -
          // durable persistence happens host-side on approval.
          rules: [{ toolName: 'RunCommand', ruleContent: 'npm test *' }],
        }),
      ],
    });

    const deniedRuns = await runtime.ops.listJobRuns(job.id);
    expect(deniedRuns).toHaveLength(1);
    expect(deniedRuns[0]).toMatchObject({
      status: 'failed',
      ended_at: expect.any(String),
      error_summary: expect.stringContaining('RunCommand'),
    });
    await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
      status: 'paused',
      pause_reason: 'Setup required',
      setup_state: expect.objectContaining({
        state: 'missing_capability',
      }),
      next_run: null,
      lease_run_id: null,
      lease_expires_at: null,
    });

    const persistentDecision: PermissionApprovalDecision = {
      approved: true,
      mode: 'allow_persistent_rule',
      decidedBy: 'job-owner',
      decisionClassification: 'user_permanent',
      updatedPermissions: setupRequest!.suggestions,
    };
    await expect(
      applyPermissionInteractionDecision({
        request: setupRequest!,
        sourceAgentFolder: setupRequest!.sourceAgentFolder,
        decision: persistentDecision,
        appId: setupRequest!.appId,
        toolName: setupRequest!.toolName,
        requestId: setupRequest!.requestId,
      }),
    ).resolves.toBe(true);
    await vi.waitFor(
      async () => {
        await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
          status: 'active',
          pause_reason: null,
          setup_state: expect.objectContaining({ state: 'ready' }),
        });
      },
      { timeout: 5_000 },
    );

    await runJob(
      (await runtime.ops.getJobById(job.id))!,
      deps,
      'tg:job-lifecycle',
    );

    expect(runnerInputs).toHaveLength(2);
    expect(decisions[1]?.decision).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'reviewed_rule',
      reason: expect.stringContaining('Allowed by'),
    });
    expect(preparePermissionInteraction).toHaveBeenCalledOnce();
    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(
      decisions.every(
        ({ runId, decision }) =>
          runId.length > 0 && decision.decidedBy !== 'auto_classifier',
      ),
    ).toBe(true);

    const runs = await runtime.ops.listJobRuns(job.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual(
      expect.arrayContaining(['failed', 'completed']),
    );
    await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
      status: 'active',
      pause_reason: null,
      setup_state: expect.objectContaining({ state: 'ready' }),
    });

    const events = await runtime.ops.listRecentJobEvents(100, {
      job_id: job.id,
    });
    const toolDecisions = events
      .filter((event) => event.event_type === 'job.tool_activity')
      .map((event) => JSON.parse(event.payload ?? '{}'))
      .filter((payload) =>
        ['permission_denied', 'permission_allowed'].includes(payload.phase),
      );
    expect(toolDecisions).toHaveLength(2);
    expect(toolDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'permission_denied',
          decided_by: 'deterministic_rails',
        }),
        expect.objectContaining({
          phase: 'permission_allowed',
          decided_by: 'reviewed_rule',
        }),
      ]),
    );
    expect(events.every((event) => event.job_id === job.id)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('auto_classifier');
  });
});
