import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { _resetSchedulerLoopForTests, runJob } from '@core/jobs/scheduler.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import { memoryAgentIdForGroupFolder } from '@core/memory/app-memory-boundaries.js';
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
    linked_sessions: ['tg:scheduler'],
    session_id: null,
    thread_id: 'thread-scheduled',
    group_scope: 'scheduler_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: false,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    execution_mode: 'serialized',
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
    isMain: false,
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
    await runtime.repositories.memory.saveMemoryItem({
      id: 'memory:integration:handoff' as never,
      appId: 'default' as never,
      agentId: agentId as never,
      subject: {
        kind: 'agent',
        appId: 'default' as never,
        agentId: agentId as never,
      },
      kind: 'fact',
      key: 'handoff',
      value: 'Previous run says keep user data private.',
      source: 'integration-test',
      confidence: 1,
      isPinned: false,
      isDeleted: false,
      createdAt: now as never,
      updatedAt: now as never,
    });

    await runJob(
      await runtime.ops.getJobById(job.id).then((saved) => saved!),
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeConversationRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: harness.channel.sendMessage,
        sendStreamingChunk: harness.channel.sendStreamingChunk,
        resetStreaming: harness.channel.resetStreaming,
        opsRepository: runtime.ops,
        runAgent: harness.runner.runAgent as never,
      },
      'tg:scheduler',
      'serialized',
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
      '<myclaw_memory_context trust="untrusted_data_only">',
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
    expect(harness.channel.resets).toEqual(['tg:scheduler']);
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
    });
    await runtime.ops.upsertJob(job);

    await runJob(
      await runtime.ops.getJobById(job.id).then((saved) => saved!),
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeConversationRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: harness.channel.sendMessage,
        sendStreamingChunk: harness.channel.sendStreamingChunk,
        resetStreaming: harness.channel.resetStreaming,
        opsRepository: runtime.ops,
        runAgent: harness.runner.runAgent as never,
      },
      'tg:scheduler',
      'serialized',
    );

    expect(harness.runner.calls[0]?.input).not.toHaveProperty('sessionId');
    await expect(runtime.ops.getJobById(job.id)).resolves.toMatchObject({
      session_id: 'control-session-correlation-only',
    });
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
      error_summary: 'planned scheduler failure',
    });
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
      'serialized',
      {
        triggerId: 'trigger:job:integration:dead-letter',
        scheduledFor: now,
      },
    );

    const [run] = await runtime.ops.listJobRuns(job.id);
    expect(run).toMatchObject({
      status: 'dead_lettered',
      error_summary: 'planned dead-letter failure',
    });
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
});
