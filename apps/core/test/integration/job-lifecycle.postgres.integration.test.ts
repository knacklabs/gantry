import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { PgBossSchedulerEngine } from '@core/infrastructure/pgboss/scheduler-engine.js';
import { configureRunSlotBackend } from '@core/jobs/concurrency.js';
import { _resetSchedulerLoopForTests, runJob } from '@core/jobs/scheduler.js';
import { registerWorkerInstance } from '@core/jobs/worker-identity.js';
import type { AgentOutput } from '@core/runtime/agent-spawn.js';

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
    await schedulerEngine?.stop();
    schedulerEngine = undefined;
  });

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

  it('terminates and audits an autonomous ungranted-tool dead-end', async () => {
    const harness = createRuntimeFlowHarness();
    const permissionRoot = mkdtempSync(
      join(tmpdir(), 'gantry-job-permission-'),
    );
    const ipcDir = join(permissionRoot, 'ipc');
    vi.stubEnv('GANTRY_WORKSPACE_GROUP_DIR', join(permissionRoot, 'group'));
    vi.stubEnv('GANTRY_WORKSPACE_EXTRA_DIR', join(permissionRoot, 'extra'));
    vi.stubEnv('GANTRY_IPC_DIR', ipcDir);
    vi.stubEnv('GANTRY_IPC_INPUT_DIR', join(ipcDir, 'input'));
    vi.stubEnv('GANTRY_IPC_AUTH_TOKEN', 'job-lifecycle-test-secret');
    vi.stubEnv('GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS', '0');
    vi.stubEnv('GANTRY_JOB_ID', 'job:integration:ungranted-tool');
    vi.resetModules();
    const { createCanUseToolCallback } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.js');
    const runnerInputs: Record<string, unknown>[] = [];
    const runnerFrames: AgentOutput[] = [];
    let permissionDecision: Awaited<
      ReturnType<ReturnType<typeof createCanUseToolCallback>>
    >;
    const runAgent = async (
      _group: ConversationRoute,
      input: Record<string, unknown>,
      _onProcess: unknown,
      onOutput?: (output: AgentOutput) => void | Promise<void>,
    ): Promise<AgentOutput> => {
      runnerInputs.push(input);
      const canUseTool = createCanUseToolCallback({
        agentInput: {
          prompt: String(input.prompt),
          appId: String(input.appId),
          agentId: String(input.agentId),
          runId: String(input.runId),
          isScheduledJob: input.isScheduledJob === true,
          jobId: String(input.jobId),
          chatJid: String(input.chatJid),
          threadId: String(input.threadId),
          workspaceFolder: basename(ipcDir),
          permissionMode: 'default',
          allowedTools: Array.isArray(input.toolPolicyRules)
            ? (input.toolPolicyRules as string[])
            : [],
        },
        sdkEnv: {},
        workspaceFolder: basename(ipcDir),
        memoryBlock: '',
        capabilities: {
          allowedTools: [],
          alwaysAllowedTools: [],
          permissionMode: 'default',
        },
        primeToolAttempts: [],
        getNewSessionId: () => undefined,
        emitInteractionBoundary: () => undefined,
        recordToolActivity: () => undefined,
      });
      const outputSpy = vi
        .spyOn(console, 'log')
        .mockImplementation((value: unknown) => {
          if (typeof value !== 'string' || !value.startsWith('{"status"')) {
            return;
          }
          const output = JSON.parse(value) as AgentOutput;
          if (output.runtimeEvents?.length) runnerFrames.push(output);
        });
      try {
        permissionDecision = await canUseTool(
          'Bash',
          { command: 'npm test -- unit' },
          {
            title: 'Run command',
            displayName: 'Bash',
            description: 'Run the job command',
            decisionReason: 'The scheduled job needs this command',
            suggestions: [],
            toolUseID: 'tool-use-job-lifecycle',
            signal: new AbortController().signal,
          },
        );
      } finally {
        outputSpy.mockRestore();
      }
      for (const frame of runnerFrames) await onOutput?.(frame);
      return { status: 'success', result: 'blocked' };
    };
    const job = makeJob('job:integration:ungranted-tool');
    await runtime.ops.upsertJob(job);

    try {
      await runJob(
        (await runtime.ops.getJobById(job.id))!,
        {
          conversationRoutes: () => ({
            'tg:job-lifecycle': makeConversationRoute(),
          }),
          queue: {} as never,
          onProcess: () => {},
          sendMessage: harness.channel.sendMessage,
          opsRepository: runtime.ops,
          runAgent: runAgent as never,
          runnerSandboxProvider: {} as never,
        },
        'tg:job-lifecycle',
      );

      const permissionRequestsDir = join(ipcDir, 'permission-requests');
      const requestFiles = readdirSync(permissionRequestsDir);
      expect(requestFiles).toHaveLength(1);
      expect(
        JSON.parse(
          readFileSync(join(permissionRequestsDir, requestFiles[0]!), 'utf8'),
        ),
      ).toMatchObject({
        jobId: job.id,
        toolName: 'RunCommand',
        unattended: true,
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(permissionRoot, { recursive: true, force: true });
    }

    expect(runnerInputs).toHaveLength(1);
    expect(runnerInputs[0]).toMatchObject({
      isScheduledJob: true,
      jobId: job.id,
      toolPolicyRules: [],
    });
    expect(permissionDecision).toMatchObject({
      behavior: 'deny',
      interrupt: true,
      message: expect.stringContaining(
        'Tool not on autonomous run allowlist: RunCommand',
      ),
    });
    expect(
      runnerFrames
        .flatMap((frame) => frame.runtimeEvents ?? [])
        .map((event) => [event.eventType, event.payload]),
    ).toEqual(
      expect.arrayContaining([
        [
          'job.tool_activity',
          expect.objectContaining({
            phase: 'permission_wait',
            tool: 'RunCommand',
            recovery_action: expect.stringContaining('request_access'),
          }),
        ],
        [
          'job.tool_activity',
          expect.objectContaining({
            phase: 'permission_denied',
            tool: 'RunCommand',
          }),
        ],
      ]),
    );
    const runs = await runtime.ops.listJobRuns(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'failed',
      ended_at: expect.any(String),
      error_summary: expect.stringContaining(
        'Tool not on autonomous run allowlist: RunCommand',
      ),
    });
    expect(runs.some((run) => run.status === 'running')).toBe(false);
    const leases = await runtime.service.pool.query<{ status: string }>(
      `SELECT status
         FROM ${quotePostgresIdentifier(runtime.schemaName)}.run_leases
        WHERE run_id = $1`,
      [runs[0]!.run_id],
    );
    expect(leases.rows).toEqual([{ status: 'failed' }]);
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

    const events = await runtime.ops.listRecentJobEvents(20, {
      job_id: job.id,
    });
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        'run.failed',
        'job.setup_required',
        'job.tool_denied',
        'job.failed',
        'job.run.failed',
      ]),
    );
    const deniedEvent = events.find(
      (event) => event.event_type === 'job.tool_denied',
    );
    expect(JSON.parse(deniedEvent?.payload ?? '{}')).toMatchObject({
      denied_tool: 'RunCommand',
      recovery_kind: 'persistent_capability',
      recovery_action: expect.stringContaining('request_access'),
    });
  });
});
