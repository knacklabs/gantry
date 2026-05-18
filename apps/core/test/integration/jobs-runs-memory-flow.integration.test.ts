import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import { _resetSchedulerLoopForTests, runJob } from '@core/jobs/scheduler.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import { memoryAgentIdForGroupFolder } from '@core/memory/app-memory-boundaries.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import type { ConversationRoute } from '@core/domain/types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import { createRuntimeFlowHarness } from '../harness/runtime-flow-harness.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const now = '2026-04-28T00:00:00.000Z';

function makeJob(id: string, patch: Partial<JobUpsertInput> = {}) {
  return {
    id,
    name: `Job ${id}`,
    prompt: 'Summarize current status',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: 'thread-scheduled',
    execution_context: {
      conversationJid: 'tg:scheduler',
      threadId: 'thread-scheduled',
      groupScope: 'scheduler_agent',
      sessionId: null,
    },
    notification_routes: [
      {
        conversationJid: 'tg:scheduler',
        threadId: 'thread-scheduled',
        label: 'primary',
      },
    ],
    group_scope: 'scheduler_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: false,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    ...patch,
  } satisfies JobUpsertInput;
}

function makeConversationRoute(): ConversationRoute {
  return {
    name: 'Scheduler Agent',
    folder: 'scheduler_agent',
    trigger: '',
    added_at: now,
    requiresTrigger: false,
    conversationKind: 'channel',
  };
}

maybeDescribe('jobs, runs, memory, and scheduler flow', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'jobs_runs_memory',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    AppMemoryService.resetForTest();
  }, 60_000);

  afterAll(async () => {
    AppMemoryService.resetForTest();
    await runtime.cleanup();
  });

  beforeEach(() => {
    _resetSchedulerLoopForTests();
  });

  it('creates a manual job, triggers the scheduler path, injects untrusted memory, and records ordered run events', async () => {
    const harness = createRuntimeFlowHarness();
    const schedulerSyncs: string[] = [];
    const job = makeJob('job:integration:success');

    const created = await runtime.ops.upsertJob(job);
    schedulerSyncs.push(job.id);
    expect({ jobId: job.id, created: created.created }).toEqual({
      jobId: job.id,
      created: true,
    });
    expect(schedulerSyncs).toEqual([job.id]);

    const agentId = memoryAgentIdForGroupFolder(job.group_scope);
    const memoryService = new AppMemoryService(runtime.service.db);
    const savedMemory = await memoryService.save({
      appId: 'default',
      agentId,
      groupId: job.group_scope,
      channelId: 'conversation:tg:scheduler',
      threadId: 'thread-scheduled',
      kind: 'fact',
      key: 'handoff',
      value: 'Previous run says keep user data private.',
      source: 'integration-test',
      confidence: 1,
    });
    expect(savedMemory).toMatchObject({
      agentId,
      subjectType: 'channel',
      groupId: job.group_scope,
      channelId: 'conversation:tg:scheduler',
      threadId: 'thread-scheduled',
      key: 'handoff',
    });

    await runJob(
      await runtime.ops.getJobById(job.id).then((saved) => saved!),
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeConversationRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: harness.channel.sendMessage,
        opsRepository: runtime.ops,
        runAgent: harness.runner.runAgent as never,
      },
      'tg:scheduler',
    );

    expect(harness.runner.calls).toHaveLength(1);
    expect(harness.runner.calls[0]?.input).toMatchObject({
      prompt: job.prompt,
      groupFolder: job.group_scope,
      chatJid: 'tg:scheduler',
      threadId: job.thread_id,
      isScheduledJob: true,
    });
    expect(String(harness.runner.calls[0]?.input.memoryContextBlock)).toContain(
      '<gantry_memory_context trust="untrusted_data_only">',
    );
    expect(String(harness.runner.calls[0]?.input.memoryContextBlock)).toContain(
      'Previous run says keep user data private.',
    );

    const runs = await runtime.ops.listJobRuns(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      job_id: job.id,
      status: 'completed',
      result_summary: 'runtime flow completed',
    });
    const persistedRuns = await runtime.service.db
      .select({
        id: pgSchema.agentRunsPostgres.id,
        sessionId: pgSchema.agentRunsPostgres.sessionId,
        jobId: pgSchema.agentRunsPostgres.jobId,
        cause: pgSchema.agentRunsPostgres.cause,
      })
      .from(pgSchema.agentRunsPostgres);
    expect(
      persistedRuns
        .filter((row) => row.jobId === job.id)
        .map((row) => ({
          id: row.id,
          sessionId: row.sessionId,
          cause: row.cause,
        })),
    ).toEqual([
      {
        id: runs[0]?.run_id,
        sessionId: null,
        cause: 'job',
      },
    ]);
    expect(
      persistedRuns.find((row) => row.id.startsWith('agent-run:')),
    ).toMatchObject({
      sessionId: expect.any(String),
      jobId: null,
      cause: 'job',
    });
    await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
      status: 'active',
      last_run: expect.any(String),
      lease_run_id: null,
    });

    const events = await runtime.ops.listRecentJobEvents(20, {
      job_id: job.id,
    });
    const eventTypes = events.map((event) => event.event_type);
    expect(eventTypes).toEqual(
      expect.arrayContaining(['job.started', 'run.completed', 'job.completed']),
    );
    expect(harness.channel.sent.map((sent) => sent.threadId)).toContain(
      job.thread_id,
    );
  });

  it('does not use or update job session_id as an SDK session handle', async () => {
    const harness = createRuntimeFlowHarness({
      runnerResult: {
        status: 'success',
        result: 'job completed with ephemeral sdk session',
        newSessionId: 'sdk-session-ignored',
      },
    });
    const job = makeJob('job:integration:canonical-session', {
      session_id: 'control-session-correlation-only',
      execution_context: {
        conversationJid: 'tg:scheduler',
        threadId: 'thread-scheduled',
        groupScope: 'scheduler_agent',
        sessionId: 'control-session-correlation-only',
      },
    });
    await runtime.ops.upsertJob(job);

    await runJob(
      await runtime.ops.getJobById(job.id).then((saved) => saved!),
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeConversationRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: harness.channel.sendMessage,
        opsRepository: runtime.ops,
        runAgent: harness.runner.runAgent as never,
      },
      'tg:scheduler',
    );

    expect(harness.runner.calls[0]?.input).not.toHaveProperty('sessionId');
    await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
      session_id: 'control-session-correlation-only',
    });
  });

  it('does not overwrite canonical agent names from system job titles', async () => {
    const graph = new PostgresCanonicalGraphRepository(runtime.service.db);
    await graph.ensureAgent('main_agent', 'Main Agent');

    await runtime.ops.upsertJob(
      makeJob('system:dreaming:main_agent:tg-5759865942', {
        group_scope: 'main_agent',
        name: 'Memory Dreaming (main_agent tg:5759865942)',
        execution_context: {
          conversationJid: 'tg:5759865942',
          threadId: null,
          groupScope: 'main_agent',
          sessionId: null,
        },
        notification_routes: [
          {
            conversationJid: 'tg:5759865942',
            threadId: null,
            label: 'Telegram DM',
          },
        ],
      }),
    );

    const rows = await runtime.service.db
      .select({ name: pgSchema.agentsPostgres.name })
      .from(pgSchema.agentsPostgres)
      .where(eq(pgSchema.agentsPostgres.id, 'agent:main_agent'))
      .limit(1);
    expect(rows[0]?.name).toBe('Main Agent');
  });

  it('uses durable scheduler lifecycle notifications for scheduler runs', async () => {
    const harness = createRuntimeFlowHarness({
      runnerResult: {
        status: 'success',
        result: 'scheduled fallback durable send',
      },
    });
    const job = makeJob('job:integration:streaming-fallback-durable');
    await runtime.ops.upsertJob(job);

    await runJob(
      await runtime.ops.getJobById(job.id).then((saved) => saved!),
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeConversationRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: harness.channel.sendMessage,
        opsRepository: runtime.ops,
        runAgent: harness.runner.runAgent as never,
      },
      'tg:scheduler',
    );

    expect(harness.channel.streams).toHaveLength(0);
    expect(harness.channel.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: 'tg:scheduler',
          text: expect.stringContaining('Running: Job'),
          threadId: job.thread_id,
        }),
        expect.objectContaining({
          jid: 'tg:scheduler',
          text: expect.stringContaining('Completed: Job'),
          threadId: job.thread_id,
        }),
      ]),
    );
  });

  it('persists failed scheduler runs without leaving a running lease', async () => {
    const harness = createRuntimeFlowHarness({
      runnerResult: {
        status: 'error',
        error: 'planned scheduler failure',
      },
    });
    const job = makeJob('job:integration:failure', {
      prompt: 'Fail this scheduled task',
    });
    await runtime.ops.upsertJob(job);

    await runJob(
      await runtime.ops.getJobById(job.id).then((saved) => saved!),
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeConversationRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: harness.channel.sendMessage,
        opsRepository: runtime.ops,
        runAgent: harness.runner.runAgent as never,
      },
      'tg:scheduler',
    );

    const [run] = await runtime.ops.listJobRuns(job.id);
    expect(run).toMatchObject({
      status: 'failed',
    });
    expect(run.error_summary).toContain('planned scheduler failure');
    await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
      status: 'active',
      consecutive_failures: 1,
      lease_run_id: null,
      next_run: null,
    });
    const events = await runtime.ops.listRecentJobEvents(20, {
      job_id: job.id,
    });
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['job.started', 'run.failed', 'job.failed']),
    );
  });

  it('dead-letters recurring jobs after threshold failure and clears lease state', async () => {
    const harness = createRuntimeFlowHarness({
      runnerResult: {
        status: 'error',
        error: 'planned dead-letter failure',
      },
    });
    const job = makeJob('job:integration:dead-letter', {
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: now,
      max_retries: 0,
      max_consecutive_failures: 1,
      silent: true,
    });
    await runtime.ops.upsertJob(job);

    await runJob(
      await runtime.ops.getJobById(job.id).then((saved) => saved!),
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeConversationRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: harness.channel.sendMessage,
        opsRepository: runtime.ops,
        runAgent: harness.runner.runAgent as never,
      },
      'tg:scheduler',
      {
        triggerId: 'trigger:job:integration:dead-letter',
        scheduledFor: now,
      },
    );

    const [run] = await runtime.ops.listJobRuns(job.id);
    expect(run).toMatchObject({
      status: 'dead_lettered',
    });
    expect(run.error_summary).toContain('planned dead-letter failure');
    await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
      status: 'dead_lettered',
      pause_reason: expect.stringContaining('planned dead-letter failure'),
      lease_run_id: null,
      lease_expires_at: null,
      next_run: null,
    });
    const events = await runtime.ops.listRecentJobEvents(20, {
      job_id: job.id,
    });
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        'job.started',
        'run.dead_lettered',
        'job.failed',
      ]),
    );
    expect(harness.channel.sent).toHaveLength(0);
  });

  it('filters owner-app run and event pages in Postgres without leaking other apps', async () => {
    const appOneSession = await runtime.control.ensureAppSession({
      appId: 'app-one',
      conversationId: 'conversation-app-one',
      chatJid: 'app:app-one:conversation',
      groupFolder: 'app_one_agent',
      title: 'App One',
    });
    const appTwoSession = await runtime.control.ensureAppSession({
      appId: 'app-two',
      conversationId: 'conversation-app-two',
      chatJid: 'app:app-two:conversation',
      groupFolder: 'app_two_agent',
      title: 'App Two',
    });
    const appOneJob = makeJob('job:integration:owner-app-one', {
      session_id: appOneSession.sessionId,
      group_scope: 'app_one_agent',
      thread_id: null,
      execution_context: {
        conversationJid: 'app:app-one:conversation',
        threadId: null,
        groupScope: 'app_one_agent',
        sessionId: appOneSession.sessionId,
      },
      notification_routes: [
        {
          conversationJid: 'app:app-one:conversation',
          threadId: null,
          label: 'primary',
        },
      ],
    });
    const appTwoJob = makeJob('job:integration:owner-app-two', {
      session_id: appTwoSession.sessionId,
      group_scope: 'app_two_agent',
      thread_id: null,
      execution_context: {
        conversationJid: 'app:app-two:conversation',
        threadId: null,
        groupScope: 'app_two_agent',
        sessionId: appTwoSession.sessionId,
      },
      notification_routes: [
        {
          conversationJid: 'app:app-two:conversation',
          threadId: null,
          label: 'primary',
        },
      ],
    });
    await runtime.ops.upsertJob(appOneJob);
    await runtime.ops.upsertJob(appTwoJob);
    await runtime.ops.createJobRun({
      run_id: 'run:integration:owner-app-one',
      job_id: appOneJob.id,
      scheduled_for: '2026-04-28T00:00:01.000Z',
      started_at: '2026-04-28T00:00:01.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    await runtime.ops.createJobRun({
      run_id: 'run:integration:owner-app-two',
      job_id: appTwoJob.id,
      scheduled_for: '2026-04-28T00:00:02.000Z',
      started_at: '2026-04-28T00:00:02.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    await runtime.repositories.runtimeEvents.appendRuntimeEvent({
      appId: 'app-one' as never,
      runId: 'run:integration:owner-app-one' as never,
      jobId: appOneJob.id as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_RUN_STARTED,
      actor: 'runtime',
      payload: { job_id: appOneJob.id },
      createdAt: '2026-04-28T00:00:01.000Z' as never,
    });
    await runtime.repositories.runtimeEvents.appendRuntimeEvent({
      appId: 'app-two' as never,
      runId: 'run:integration:owner-app-two' as never,
      jobId: appTwoJob.id as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_RUN_STARTED,
      actor: 'runtime',
      payload: { job_id: appTwoJob.id },
      createdAt: '2026-04-28T00:00:02.000Z' as never,
    });

    await expect(
      runtime.ops.listJobRuns(undefined, 10, { ownerAppId: 'app-one' }),
    ).resolves.toEqual([
      expect.objectContaining({
        run_id: 'run:integration:owner-app-one',
        job_id: appOneJob.id,
      }),
    ]);
    await expect(
      runtime.ops.listJobRuns(undefined, 10, { ownerAppId: 'app-two' }),
    ).resolves.toEqual([
      expect.objectContaining({
        run_id: 'run:integration:owner-app-two',
        job_id: appTwoJob.id,
      }),
    ]);
    await expect(
      runtime.ops.listRecentJobEvents(10, { owner_app_id: 'app-one' }),
    ).resolves.toEqual([
      expect.objectContaining({
        run_id: 'run:integration:owner-app-one',
        job_id: appOneJob.id,
      }),
    ]);
    await expect(
      runtime.ops.listJobRuns(undefined, 10, { jobIds: [] }),
    ).resolves.toEqual([]);
    await expect(
      runtime.ops.listRecentJobEvents(10, { job_ids: [] }),
    ).resolves.toEqual([]);

    const schema = quotePostgresIdentifier(runtime.schemaName);
    await runtime.service.pool.query('BEGIN');
    try {
      await runtime.service.pool.query('SET LOCAL enable_seqscan = off');
      const runPlan = await runtime.service.pool.query<{
        'QUERY PLAN': string;
      }>(
        `EXPLAIN
         SELECT r.id
         FROM ${schema}.control_http_sessions s
         JOIN ${schema}.jobs j
           ON s.session_id = j.target_json #>> '{executionContext,sessionId}'
         JOIN ${schema}.agent_runs r
           ON r.job_id = j.id
         WHERE s.app_id = $1
         ORDER BY r.started_at DESC NULLS LAST, r.created_at DESC
         LIMIT 10`,
        ['app-one'],
      );
      const eventPlan = await runtime.service.pool.query<{
        'QUERY PLAN': string;
      }>(
        `EXPLAIN
         SELECT e.event_id
         FROM ${schema}.control_http_sessions s
         JOIN ${schema}.jobs j
           ON s.session_id = j.target_json #>> '{executionContext,sessionId}'
         JOIN ${schema}.runtime_events e
           ON e.job_id = j.id
         WHERE s.app_id = $1
           AND e.event_type = 'job.run.started'
         ORDER BY e.event_id DESC
         LIMIT 10`,
        ['app-one'],
      );
      const runPlanText = runPlan.rows
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      expect(runPlanText).toContain('idx_jobs_target_session_updated');
      expect(runPlanText).toMatch(
        /idx_agent_runs_(job_started|job_short_id_unique)/,
      );
      const eventPlanText = eventPlan.rows
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      expect(eventPlanText).toMatch(
        /idx_runtime_events_(job_cursor|type_cursor)/,
      );
    } finally {
      await runtime.service.pool.query('ROLLBACK');
    }
  });
});
