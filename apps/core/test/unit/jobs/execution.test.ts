import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AmbiguousDurableDeliveryError } from '@core/domain/messages/durable-delivery.js';
import type { ConversationRoute, Job } from '@core/domain/types.js';

const runtimeStoreMock = vi.hoisted(() => ({
  publish: vi.fn(async () => undefined),
  appendRunnerControlEvent: vi.fn(async () => 'persisted'),
  heartbeatRunLease: vi.fn(async () => true),
  bindPendingTriggerToRun: vi.fn(async () => null),
  bindTriggerToRun: vi.fn(async () => null),
  getAppSessionById: vi.fn(async () => null),
  markTriggerCompleted: vi.fn(async () => undefined),
}));

vi.mock('@core/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/config/index.js')>();
  return {
    ...actual,
    ASSISTANT_NAME: 'Andy',
    getEffectiveModelConfig: () => ({ model: 'opus' }),
  };
});

vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: () => '/tmp/gantry-unit-scheduler-agent',
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => ({
    bindPendingTriggerToRun: runtimeStoreMock.bindPendingTriggerToRun,
    bindTriggerToRun: runtimeStoreMock.bindTriggerToRun,
    getAppSessionById: runtimeStoreMock.getAppSessionById,
    markTriggerCompleted: runtimeStoreMock.markTriggerCompleted,
  }),
  getRuntimeEventExchange: () => ({
    publish: runtimeStoreMock.publish,
  }),
  getWorkerCoordinationRepository: () => ({
    appendRunnerControlEvent: runtimeStoreMock.appendRunnerControlEvent,
    heartbeatRunLease: runtimeStoreMock.heartbeatRunLease,
  }),
  getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
}));

vi.mock('@core/jobs/worker-identity.js', () => ({
  requireWorkerInstanceId: () => 'worker-test',
}));

vi.mock('@core/jobs/compact-memory.js', () => ({
  collectCompactBoundaryMemory: vi.fn(async () => undefined),
  collectJobCompletionMemory: vi.fn(async () => undefined),
}));

vi.mock('@core/jobs/system-jobs.js', () => ({
  MEMORY_DREAM_SYSTEM_PROMPT: '__system:memory_dream',
  handleSystemJob: vi.fn(async () => 'System job completed.'),
}));

const systemJobs = await import('@core/jobs/system-jobs.js');
const runtimeStore =
  await import('@core/adapters/storage/postgres/runtime-store.js');
const getConfiguredModelProvidersForAppMock = vi.mocked(
  runtimeStore.getConfiguredModelProvidersForApp,
);
const { runJob } = await import('@core/jobs/execution.js');
const { evaluateJobReadiness } =
  await import('@core/application/jobs/job-readiness-service.js');
const { RUNTIME_RESULT_SUMMARY_MAX_CHARS } =
  await import('@core/runtime/session-resume-runtime.js');
const compactMemory = await import('@core/jobs/compact-memory.js');
const collectJobCompletionMemoryMock = vi.mocked(
  compactMemory.collectJobCompletionMemory,
);
const handleSystemJobMock = vi.mocked(systemJobs.handleSystemJob);

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    app_id: 'default',
    name: 'Daily summary',
    prompt: 'Summarize current status',
    schedule_type: 'manual',
    schedule: '',
    enabled: true,
    status: 'active',
    session_id: null,
    thread_id: 'thread-scheduled',
    execution_context: {
      conversationJid: 'tg:scheduler',
      threadId: 'thread-scheduled',
      workspaceKey: 'scheduler_agent',
    },
    notification_routes: [
      {
        conversationJid: 'tg:scheduler',
        threadId: 'thread-scheduled',
        label: 'primary',
      },
    ],
    workspace_key: 'scheduler_agent',
    created_by: 'human',
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    consecutive_failures: 0,
    max_consecutive_failures: 3,
    cleanup_after_ms: null,
    ...overrides,
  } as Job;
}

function makeRoute(): ConversationRoute {
  return {
    name: 'Scheduler Agent',
    folder: 'scheduler_agent',
    trigger: '',
    added_at: '2026-05-08T00:00:00.000Z',
    requiresTrigger: false,
  };
}

function makeOpsRepository(job: Job) {
  const repo = {
    getJobById: vi.fn(async () => job),
    getJobRunById: vi.fn(async () => ({
      run_id: 'run-1',
      job_id: job.id,
      short_id: 1,
      status: 'running',
    })),
    claimDueJobRunStart: vi.fn(async () => ({
      runId: 'run-1',
      jobId: job.id,
      workerInstanceId: 'worker-test',
      leaseToken: 'lease-token-1',
      fencingVersion: 1,
      status: 'active' as const,
      claimedAt: '2026-05-08T00:00:00.000Z',
      expiresAt: '2026-05-08T01:00:00.000Z',
      heartbeatAt: '2026-05-08T00:00:00.000Z',
    })),
    settleJobRunLease: vi.fn(async () => true),
    updateAgentRunProviderMetadata: vi.fn(async () => true),
    createJobRun: vi.fn(async () => true),
    updateJob: vi.fn(async () => undefined),
    completeJobRun: vi.fn(async () => undefined),
    finalizeJobRunLease: vi.fn(async (input) => {
      await repo.completeJobRun(
        input.runId,
        input.runStatus,
        input.resultSummary ?? null,
        input.errorSummary ?? null,
      );
      return true;
    }),
    finalizeJobRunWithLease: vi.fn(async (input) => {
      await repo.updateJob(input.jobId, input.jobUpdates);
      await repo.completeJobRun(
        input.runId,
        input.runStatus,
        input.resultSummary ?? null,
        input.errorSummary ?? null,
      );
      return true;
    }),
    markJobRunNotified: vi.fn(async () => true),
    listRecentJobEvents: vi.fn(async () => []),
  };
  return repo;
}

function makeToolRepository(toolNames: string[]) {
  const toolFor = (toolName: string) => ({
    id: toolName,
    appId: 'default',
    name: toolName,
    kind: 'host',
    provider: 'gantry',
    displayName: toolName,
    category: 'agent',
    risk: 'medium',
    selectable: true,
    status: 'active',
    adapterRef: toolName,
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
  });
  return {
    listTools: vi.fn(async () =>
      toolNames.map((toolName) => toolFor(toolName)),
    ),
    listAgentToolBindings: vi.fn(async () =>
      toolNames.map((toolName) => ({
        toolId: toolName,
        appId: 'default',
        agentId: 'agent:scheduler_agent',
        status: 'active',
      })),
    ),
    getTool: vi.fn(async (toolId: string) => toolFor(toolId)),
  };
}

describe('jobs/execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeStoreMock.appendRunnerControlEvent.mockResolvedValue('persisted');
    runtimeStoreMock.heartbeatRunLease.mockResolvedValue(true);
    handleSystemJobMock.mockResolvedValue('System job completed.');
  });

  it('records a failed terminal run when execution throws before normal settlement', async () => {
    const job = makeJob();
    const opsRepository = {
      ...makeOpsRepository(job),
      getJobRunById: vi.fn(async () => {
        throw new Error('run lookup down');
      }),
    };

    await expect(
      runJob(
        job,
        {
          conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
          queue: {} as never,
          onProcess: () => {},
          sendMessage: vi.fn(async () => undefined) as never,
          opsRepository: opsRepository as never,
          runAgent: vi.fn(async () => ({
            status: 'success',
            result: 'runtime flow completed',
          })) as never,
        },
        'tg:scheduler',
      ),
    ).rejects.toThrow('run lookup down');

    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      null,
      'Scheduler run failed before terminal settlement.',
    );
  });

  it('records and notifies unresolved execution routes as dead-lettered runs', async () => {
    const job = makeJob({
      execution_context: {
        conversationJid: 'tg:missing',
        threadId: null,
        workspaceKey: 'scheduler_agent',
      },
    });
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);

    await runJob(
      job,
      {
        conversationRoutes: () => ({}),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn() as never,
        executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      },
      'tg:scheduler',
    );

    expect(opsRepository.claimDueJobRunStart).not.toHaveBeenCalled();
    expect(opsRepository.createJobRun).toHaveBeenCalledWith(
      expect.objectContaining({
        job_id: 'job-1',
        status: 'dead_lettered',
        error_summary: 'Execution context route not found: tg:missing',
      }),
    );
    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'dead_lettered',
        pause_reason: 'Execution context route not found: tg:missing',
        next_run: null,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('**⏸️ Paused after failures** · Daily summary'),
      expect.objectContaining({ threadId: 'thread-scheduled' }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.failed',
        jobId: 'job-1',
        payload: expect.objectContaining({
          status: 'dead_lettered',
          delivery_state: 'sent',
        }),
      }),
    );
  });

  it('redacts provider session handles from completed scheduler summaries and events', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);
    const rawResult =
      'done provider-session:raw-result claude-session-result sessionId=result-inline {"newSessionId":"json-result"}';

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn(async () => ({
          status: 'success',
          result: rawResult,
        })) as never,
      },
      'tg:scheduler',
    );

    const completionSummary = vi.mocked(opsRepository.completeJobRun).mock
      .calls[0]?.[2];
    expect(completionSummary).toContain('[REDACTED]');
    expect(completionSummary).not.toContain('provider-session:raw-result');
    expect(completionSummary).not.toContain('claude-session-result');
    expect(completionSummary).not.toContain('result-inline');
    expect(completionSummary).not.toContain('json-result');

    const completionMessage = sendMessage.mock.calls.at(-1)?.[1] as string;
    expect(completionMessage).toContain('**✅ Completed** · Daily summary');
    expect(completionMessage).toContain('[REDACTED]');
    expect(completionMessage).not.toContain('provider-session:raw-result');
    expect(completionMessage).not.toContain('claude-session-result');
    expect(completionMessage).not.toContain('result-inline');
    expect(completionMessage).not.toContain('json-result');

    const jobCompletedEvent = runtimeStoreMock.publish.mock.calls.find(
      ([event]) => event?.eventType === 'job.completed',
    )?.[0];
    expect(jobCompletedEvent?.payload?.summary).toContain('[REDACTED]');
    expect(jobCompletedEvent?.payload?.summary).not.toContain(
      'provider-session:raw-result',
    );
    expect(jobCompletedEvent?.payload?.summary).not.toContain(
      'claude-session-result',
    );
    expect(jobCompletedEvent?.payload?.summary).not.toContain('result-inline');
    expect(jobCompletedEvent?.payload?.summary).not.toContain('json-result');

    const runCompletedEvent = runtimeStoreMock.publish.mock.calls.find(
      ([event]) => event?.eventType === 'job.run.completed',
    )?.[0];
    expect(runCompletedEvent?.payload?.summary).toContain('[REDACTED]');
    expect(runCompletedEvent?.payload?.summary).not.toContain(
      'provider-session:raw-result',
    );
    expect(runCompletedEvent?.payload?.summary).not.toContain(
      'claude-session-result',
    );
    expect(runCompletedEvent?.payload?.summary).not.toContain('result-inline');
    expect(runCompletedEvent?.payload?.summary).not.toContain('json-result');
  });

  it('passes an abortable deadline into host-owned system jobs', async () => {
    const job = makeJob({
      id: 'system:dreaming:scheduler_agent:abc123',
      name: 'Memory Dreaming',
      prompt: '__system:memory_dream',
      timeout_ms: 1_260_000,
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: '2026-05-08T00:00:00.000Z',
    });
    const opsRepository = makeOpsRepository(job);

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn() as never,
      },
      'tg:scheduler',
    );

    expect(handleSystemJobMock).toHaveBeenCalledWith(
      job,
      expect.objectContaining({
        folder: 'scheduler_agent',
        conversationId: 'tg:scheduler',
        threadId: 'thread-scheduled',
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        deadlineAtMs: expect.any(Number),
      }),
    );
    const options = handleSystemJobMock.mock.calls[0]?.[2] as
      | { deadlineAtMs?: number }
      | undefined;
    expect(options?.deadlineAtMs).toBeGreaterThan(Date.now() + 1_100_000);
    expect(options?.deadlineAtMs).toBeLessThanOrEqual(Date.now() + 1_260_000);
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      'System job completed.',
      null,
    );
  });

  it('settles host-owned system job deadline expiry as a scheduler timeout', async () => {
    vi.useFakeTimers({
      now: new Date('2026-05-08T00:00:00.000Z'),
    });
    try {
      const job = makeJob({
        id: 'system:dreaming:scheduler_agent:abc123',
        name: 'Memory Dreaming',
        prompt: '__system:memory_dream',
        timeout_ms: 30_000,
        schedule_type: 'interval',
        schedule_value: '60000',
        next_run: '2026-05-08T00:00:00.000Z',
      });
      const opsRepository = makeOpsRepository(job);
      handleSystemJobMock.mockImplementation(
        async (_job, _context, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            );
          }),
      );

      const run = runJob(
        job,
        {
          conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
          queue: {} as never,
          onProcess: () => {},
          sendMessage: vi.fn(async () => undefined) as never,
          opsRepository: opsRepository as never,
          runAgent: vi.fn() as never,
        },
        'tg:scheduler',
        { jobId: job.id, runId: 'run-1' },
      );
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }

      await vi.advanceTimersByTimeAsync(30_001);
      await run;

      expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
        expect.any(String),
        'timeout',
        null,
        expect.stringContaining('System job timed out after 30000ms'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses policy-denied recurring jobs with structured setup recovery events', async () => {
    const job = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: '2026-05-08T00:00:00.000Z',
    });
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);
    const error =
      'Tool not on autonomous run allowlist: mcp__gantry__browser_act. Recovery: request_access { "target": { "kind": "capability", "id": "browser.use" }, "temporaryOnly": false }';

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn(async () => ({
          status: 'error',
          result: null,
          error,
        })) as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        setup_state: expect.objectContaining({
          state: 'missing_capability',
        }),
      }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      null,
      expect.stringContaining('Tool not on autonomous run allowlist'),
    );
    const deniedEvent = runtimeStoreMock.publish.mock.calls.find(
      ([event]) => event?.eventType === 'job.tool_denied',
    )?.[0];
    expect(deniedEvent?.payload).toEqual(
      expect.objectContaining({
        denied_tool: 'mcp__gantry__browser_act',
        recovery_kind: 'persistent_capability',
        recovery_action: expect.stringContaining('request_access'),
      }),
    );
    const messages = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(messages).toContainEqual(
      expect.stringContaining('**▶️ Running** ·'),
    );
    expect(messages).toContainEqual(
      expect.stringContaining('**🛠️ Setup needed** ·'),
    );
    expect(messages).not.toContainEqual(
      expect.stringContaining('**🔐 Needs permission** ·'),
    );
  });

  it('finalizes policy-denied jobs even when session-run bookkeeping fails', async () => {
    const job = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: '2026-05-08T00:00:00.000Z',
    });
    const opsRepository = {
      ...makeOpsRepository(job),
      getAgentTurnContext: vi.fn(async () => ({
        appId: 'default',
        agentId: 'agent:scheduler_agent',
        agentSessionId: 'agent-session:scheduler',
      })),
      createSessionAgentRun: vi.fn(async () => 'agent-run:job-1'),
      completeSessionAgentRun: vi
        .fn()
        .mockRejectedValue(new Error('session bookkeeping unavailable')),
    };
    const error =
      'Tool not on autonomous run allowlist: RunCommand. Recovery: request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false}';

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn(async () => ({
          status: 'error',
          result: null,
          error,
        })) as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.completeSessionAgentRun).toHaveBeenCalled();
    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        lease_run_id: null,
      }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      null,
      expect.stringContaining('Tool not on autonomous run allowlist'),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.run.failed',
      }),
    );
  });

  it('pauses policy-denied manual jobs instead of reactivating them', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const error =
      'Tool not on autonomous run allowlist: RunCommand. Recovery: request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false}';

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn(async () => ({
          status: 'error',
          result: null,
          error,
        })) as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        setup_state: expect.objectContaining({
          state: 'missing_capability',
        }),
      }),
    );
    expect(opsRepository.updateJob).not.toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: 'active',
        pause_reason: null,
      }),
    );
  });

  it('pauses recurring jobs after transient permission approvals', async () => {
    const job = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: '2026-05-08T00:00:00.000Z',
    });
    const opsRepository = makeOpsRepository(job);
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'job.tool_activity',
            payload: {
              phase: 'permission_allowed',
              tool: 'Bash',
              mode: 'allow_once',
              ok: true,
            },
          },
        ],
      } as never);
      return { status: 'success', result: 'completed with one-time grant' };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
        executionAdapter: {
          id: 'anthropic:claude-agent-sdk',
          prepare: vi.fn(),
        } as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      'completed with one-time grant',
      null,
    );
    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        next_run: null,
        setup_state: expect.objectContaining({
          state: 'missing_capability',
          blockers: expect.arrayContaining([
            expect.objectContaining({
              requirementId: 'RunCommand',
              nextAction: expect.stringContaining('request_access'),
            }),
          ]),
        }),
      }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.setup_required',
        payload: expect.objectContaining({
          setup_state: 'missing_capability',
        }),
      }),
    );
  });

  it('keeps the runner alive after a transient scheduler run lease heartbeat failure', async () => {
    vi.useFakeTimers();
    try {
      runtimeStoreMock.heartbeatRunLease
        .mockRejectedValueOnce(new Error('db unavailable'))
        .mockResolvedValue(true);
      const job = makeJob();
      const opsRepository = makeOpsRepository(job);
      let runStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        runStarted = resolve;
      });
      let finishRun: (() => void) | undefined;
      let runSignal: AbortSignal | undefined;
      const runAgent = vi.fn(
        async (_group, _input, _onProcess, _onStream, options) => {
          runSignal = options.signal;
          runStarted?.();
          return new Promise((resolve) => {
            finishRun = () =>
              resolve({
                status: 'success',
                result: 'runtime flow completed',
              });
          });
        },
      );

      const run = runJob(
        job,
        {
          conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
          queue: {} as never,
          onProcess: () => {},
          sendMessage: vi.fn(async () => undefined) as never,
          opsRepository: opsRepository as never,
          runAgent: runAgent as never,
          executionAdapter: {
            id: 'anthropic:claude-agent-sdk',
            prepare: vi.fn(),
          } as never,
        },
        'tg:scheduler',
        { jobId: job.id, runId: 'run-1' },
      );

      await started;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runSignal?.aborted).toBe(false);
      finishRun?.();
      await run;

      expect(runtimeStoreMock.heartbeatRunLease).toHaveBeenCalledWith({
        runId: 'run-1',
        leaseToken: 'lease-token-1',
        ttlMs: 40_000,
      });
      expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
        'run-1',
        'completed',
        'runtime flow completed',
        null,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts dead-letter scheduler error summaries, pause reason, and events', async () => {
    const job = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      max_retries: 0,
      max_consecutive_failures: 1,
    });
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);
    const rawError =
      'failed provider-session:raw-error claude-session-error sessionId=error-inline {"newSessionId":"json-error"}';

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn(async () => ({
          status: 'error',
          error: rawError,
        })) as never,
      },
      'tg:scheduler',
    );

    const completionError = vi.mocked(opsRepository.completeJobRun).mock
      .calls[0]?.[3];
    expect(completionError).toContain('[REDACTED]');
    expect(completionError).not.toContain('provider-session:raw-error');
    expect(completionError).not.toContain('claude-session-error');
    expect(completionError).not.toContain('error-inline');
    expect(completionError).not.toContain('json-error');

    const deadLetterUpdate = vi
      .mocked(opsRepository.updateJob)
      .mock.calls.find(([, update]) => update?.status === 'dead_lettered')?.[1];
    // Pause reason is now generic + actionable — the raw error is NOT embedded
    // (it lives on the run record, asserted above). This is the stronger
    // non-leak guarantee: no error text at all, not just a redacted one.
    expect(deadLetterUpdate?.pause_reason).toContain('Fix the blocker');
    expect(deadLetterUpdate?.pause_reason).not.toContain(
      'provider-session:raw-error',
    );
    expect(deadLetterUpdate?.pause_reason).not.toContain(
      'claude-session-error',
    );
    expect(deadLetterUpdate?.pause_reason).not.toContain('error-inline');
    expect(deadLetterUpdate?.pause_reason).not.toContain('json-error');

    const failureMessage = sendMessage.mock.calls.at(-1)?.[1] as string;
    expect(failureMessage).toContain(
      '**⏸️ Paused after failures** · Daily summary',
    );
    expect(failureMessage).toContain('Needs attention:');
    expect(failureMessage).toContain('[REDACTED]');
    expect(failureMessage).not.toContain('provider-session:raw-error');
    expect(failureMessage).not.toContain('claude-session-error');
    expect(failureMessage).not.toContain('error-inline');
    expect(failureMessage).not.toContain('json-error');

    const lifecycleFailureEvent = runtimeStoreMock.publish.mock.calls.find(
      ([event]) => event?.eventType === 'job.failed',
    )?.[0];
    expect(lifecycleFailureEvent?.payload?.summary).toContain('[REDACTED]');
    expect(lifecycleFailureEvent?.payload?.summary).not.toContain(
      'provider-session:raw-error',
    );
    expect(lifecycleFailureEvent?.payload?.summary).not.toContain(
      'claude-session-error',
    );
    expect(lifecycleFailureEvent?.payload?.summary).not.toContain(
      'error-inline',
    );
    expect(lifecycleFailureEvent?.payload?.summary).not.toContain('json-error');
    expect(lifecycleFailureEvent?.payload?.pause_reason).toContain(
      'Fix the blocker',
    );
    expect(lifecycleFailureEvent?.payload?.pause_reason).not.toContain(
      'provider-session:raw-error',
    );
    expect(lifecycleFailureEvent?.payload?.pause_reason).not.toContain(
      'claude-session-error',
    );
    expect(lifecycleFailureEvent?.payload?.pause_reason).not.toContain(
      'error-inline',
    );
    expect(lifecycleFailureEvent?.payload?.pause_reason).not.toContain(
      'json-error',
    );

    const runFailureEvent = runtimeStoreMock.publish.mock.calls.find(
      ([event]) => event?.eventType === 'job.run.failed',
    )?.[0];
    expect(runFailureEvent?.payload?.summary).toContain('[REDACTED]');
    expect(runFailureEvent?.payload?.summary).not.toContain(
      'provider-session:raw-error',
    );
    expect(runFailureEvent?.payload?.summary).not.toContain(
      'claude-session-error',
    );
    expect(runFailureEvent?.payload?.summary).not.toContain('error-inline');
    expect(runFailureEvent?.payload?.summary).not.toContain('json-error');
  });

  it('sends one terminal summary when start notification settlement is ambiguous', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi
      .fn<(...args: [string, string, { threadId: string }]) => Promise<void>>()
      .mockRejectedValueOnce(
        new AmbiguousDurableDeliveryError({
          provider: 'telegram',
          conversationJid: 'tg:scheduler',
          cause: new Error('sent settlement failed'),
        }),
      )
      .mockResolvedValue(undefined);

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn(async () => ({
          status: 'success',
          result: 'actual job result',
        })) as never,
      },
      'tg:scheduler',
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'tg:scheduler',
      expect.stringContaining('**▶️ Running** · Daily summary'),
      { threadId: 'thread-scheduled' },
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'tg:scheduler',
      expect.stringContaining('**✅ Completed** · Daily summary'),
      expect.objectContaining({ threadId: 'thread-scheduled' }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      'actual job result',
      null,
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.completed',
        payload: expect.objectContaining({
          delivery_state: 'sent',
          start_notification_state: 'not_sent',
          summary: 'actual job result',
        }),
      }),
    );
  });

  it('records scheduler provider run handles on outer and session runs', async () => {
    const job = makeJob();
    const opsRepository = {
      ...makeOpsRepository(job),
      getAgentTurnContext: vi.fn(async () => ({
        appId: 'default',
        agentId: 'agent:scheduler_agent',
        agentSessionId: 'agent-session:scheduler',
        providerSessionId: 'provider-session:resume',
        externalSessionId: 'provider-session:resume',
      })),
      createSessionAgentRun: vi.fn(async () => 'agent-run:job-1'),
      completeSessionAgentRun: vi.fn(async () => undefined),
    };
    const runAgent = vi.fn(async (_group, _input, onProcess) => {
      onProcess({} as never, 'provider-run:scheduler-1');
      return {
        status: 'success',
        result: 'runtime flow completed',
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: vi.fn(),
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
        executionAdapter: {
          id: 'anthropic:claude-agent-sdk',
          prepare: vi.fn(),
        } as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.createSessionAgentRun).toHaveBeenCalledWith({
      agentSessionId: 'agent-session:scheduler',
      executionProviderId: 'anthropic:claude-agent-sdk',
      providerSessionId: 'provider-session:resume',
      cause: 'job',
    });
    expect(opsRepository.updateAgentRunProviderMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        leaseToken: 'lease-token-1',
        workerInstanceId: 'worker-test',
        fencingVersion: 1,
        providerSessionId: 'provider-session:resume',
      }),
    );
    expect(opsRepository.updateAgentRunProviderMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        leaseToken: 'lease-token-1',
        workerInstanceId: 'worker-test',
        fencingVersion: 1,
        fenceRunId: expect.any(String),
        runIds: ['agent-run:job-1'],
        providerRunId: 'provider-run:scheduler-1',
      }),
    );
  });

  it('hydrates scheduled job memory from the bounded prompt query before running the agent', async () => {
    const noisyPrompt = `<context timezone="UTC" />
<messages>
<message sender="User">${Array.from(
      { length: 140 },
      (_, index) => `term${index}`,
    ).join(' ')}</message>
</messages>`;
    const job = makeJob({ prompt: noisyPrompt });
    const opsRepository = {
      ...makeOpsRepository(job),
      getAgentTurnContext: vi.fn(async () => ({
        appId: 'default',
        agentId: 'agent:scheduler_agent',
        agentSessionId: 'agent-session:scheduler',
        memoryContextBlock:
          '<gantry_memory_context trust="untrusted_data_only">job memory</gantry_memory_context>',
      })),
    };
    const runAgent = vi.fn(async () => ({
      status: 'success',
      result: 'runtime flow completed',
    }));
    const collectSessionMemory = vi.fn(async () => ({ saved: 0 }));

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        collectSessionMemory: collectSessionMemory as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentFolder: 'scheduler_agent',
        conversationJid: 'tg:scheduler',
        threadId: 'thread-scheduled',
        conversationKind: undefined,
        memoryUserId: undefined,
        jobId: job.id,
        query: expect.not.stringContaining('<message'),
      }),
    );
    const recallQuery = opsRepository.getAgentTurnContext.mock.calls[0]?.[0]
      .query as string;
    expect(recallQuery).not.toContain('timezone=');
    expect(recallQuery.split(/\s+/)).toHaveLength(80);
    expect(recallQuery.length).toBeLessThanOrEqual(1200);
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: noisyPrompt,
        memoryContextBlock:
          '<gantry_memory_context trust="untrusted_data_only">job memory</gantry_memory_context>',
      }),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 30000 }),
    );
    expect(collectJobCompletionMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: 'agent-session:scheduler',
        collectMemory: collectSessionMemory,
        defaultScope: 'group',
      }),
    );
  });

  it('does not persist streamed provider resume handles in the job-owned session scope', async () => {
    const job = makeJob();
    const opsRepository = {
      ...makeOpsRepository(job),
      getAgentTurnContext: vi.fn(async () => ({
        appId: 'default',
        agentId: 'agent:scheduler_agent',
        agentSessionId: 'agent-session:scheduler',
      })),
      createSessionAgentRun: vi.fn(async () => 'agent-run:job-1'),
      completeSessionAgentRun: vi.fn(async () => undefined),
      setSession: vi.fn(async () => true),
    };
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        newSessionId: 'provider-session:streamed',
      } as never);
      return {
        status: 'success',
        result: 'runtime flow completed',
        newSessionId: 'provider-session:streamed',
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.setSession).not.toHaveBeenCalled();
    expect(opsRepository.updateAgentRunProviderMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        leaseToken: 'lease-token-1',
        workerInstanceId: 'worker-test',
        fencingVersion: 1,
        fenceRunId: expect.any(String),
        runIds: ['agent-run:job-1'],
        providerSessionId: 'provider-session:streamed',
      }),
    );
  });

  it('inherits Browser for jobs without projecting raw browser MCP tools', async () => {
    const job = makeJob({
      prompt: 'navigate to https://example.com and take a screenshot',
    });
    const opsRepository = {
      ...makeOpsRepository(job),
      getAgentTurnContext: vi.fn(async () => ({
        appId: 'default',
        agentId: 'agent:scheduler_agent',
        agentSessionId: 'agent-session:scheduler',
      })),
    };
    const runAgent = vi.fn(async () => ({
      status: 'success',
      result: 'runtime flow completed',
    }));

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () =>
          ({
            listTools: vi.fn(async () => [
              {
                id: 'tool:Browser',
                appId: 'default',
                name: 'Browser',
                kind: 'browser',
                provider: 'gantry',
                displayName: 'Browser',
                category: 'web',
                risk: 'medium',
                selectable: true,
                status: 'active',
                adapterRef: 'Browser',
                createdAt: '2026-05-08T00:00:00.000Z',
                updatedAt: '2026-05-08T00:00:00.000Z',
              },
            ]),
            listAgentToolBindings: vi.fn(async () => [
              { toolId: 'tool:Browser', status: 'active' },
            ]),
            getTool: vi.fn(async () => ({
              id: 'tool:Browser',
              appId: 'default',
              name: 'Browser',
            })),
          }) as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toolPolicyRules: ['Browser'],
      }),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 30000 }),
    );
  });

  it('inherits selected skills and MCP servers from the target agent at run time', async () => {
    const job = makeJob();
    const opsRepository = {
      ...makeOpsRepository(job),
      getAgentTurnContext: vi.fn(async () => ({
        appId: 'default',
        agentId: 'agent:scheduler_agent',
        agentSessionId: 'agent-session:scheduler',
      })),
    };
    const skillRepository = {
      listAgentSkillBindings: vi.fn(async () => [
        { skillId: 'skill:release', status: 'active' },
        { skillId: 'skill:draft', status: 'inactive' },
      ]),
      getSkill: vi.fn(async (id: string) =>
        id === 'skill:release'
          ? { id, appId: 'default', name: 'release', status: 'installed' }
          : null,
      ),
    };
    const mcpServerRepository = {
      listAgentBindings: vi.fn(async () => [
        { serverId: 'mcp:github', status: 'active' },
        { serverId: 'mcp:legacy', status: 'inactive' },
      ]),
      getServer: vi.fn(async (id: string) =>
        id === 'mcp:github'
          ? { id, appId: 'default', name: 'github' }
          : { id, appId: 'default', name: 'legacy' },
      ),
    };
    const toolRepository = {
      listTools: vi.fn(async () => [
        {
          id: 'tool:github-search',
          appId: 'default',
          name: 'capability:repo.search.repositories',
          inputSchema: {
            format: 'gantry.semantic-capability.v1',
            schema: {
              capabilityId: 'repo.search.repositories',
              displayName: 'Repo search repositories',
              category: 'Repository',
              risk: 'read',
              can: 'Search repositories through reviewed source access.',
              cannot: 'Modify repositories or change repository settings.',
              credentialSource: 'none',
              implementationBindings: [
                {
                  kind: 'mcp_tool',
                  mcpTool: 'mcp__github__search_repositories',
                },
              ],
            },
          },
        },
      ]),
      listAgentToolBindings: vi.fn(async () => [
        { toolId: 'tool:github-search', status: 'active' },
      ]),
      getTool: vi.fn(async () => ({
        appId: 'default',
        name: 'capability:repo.search.repositories',
        inputSchema: {
          format: 'gantry.semantic-capability.v1',
          schema: {
            capabilityId: 'repo.search.repositories',
            displayName: 'Repo search repositories',
            category: 'Repository',
            risk: 'read',
            can: 'Search repositories through reviewed source access.',
            cannot: 'Modify repositories or change repository settings.',
            credentialSource: 'none',
            implementationBindings: [
              {
                kind: 'mcp_tool',
                mcpTool: 'mcp__github__search_repositories',
              },
            ],
          },
        },
      })),
    };
    const skillArtifactStore = { readArtifact: vi.fn() };
    const capabilitySecretRepository = {};
    const mcpHostnameLookup = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ]);
    const credentialBroker = {
      getCredentialInjection: vi.fn(async () => ({
        env: {},
        metadata: {},
      })),
    };
    const runAgent = vi.fn(async () => ({
      status: 'success',
      result: 'runtime flow completed',
    }));

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getCredentialBroker: vi.fn(async () => credentialBroker) as never,
        getToolRepository: () => toolRepository as never,
        getSkillRepository: () => skillRepository as never,
        getMcpServerRepository: () => mcpServerRepository as never,
        getCapabilitySecretRepository: () =>
          capabilitySecretRepository as never,
        getMcpHostnameLookup: () => mcpHostnameLookup as never,
        getSkillArtifactStore: () => skillArtifactStore as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(skillRepository.listAgentSkillBindings).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:scheduler_agent',
    });
    expect(mcpServerRepository.listAgentBindings).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:scheduler_agent',
      limit: 500,
    });
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attachedSkillSourceIds: ['skill:release'],
        selectedSkillDisplays: ['release (skill:release)'],
        attachedMcpSourceIds: ['mcp:github'],
      }),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        timeoutMs: 30000,
        credentialBroker,
        skillRepository,
        skillArtifactStore,
        capabilitySecretRepository,
        mcpServerRepository,
        mcpHostnameLookup,
      }),
    );
  });

  it('falls back to the execution context route and Telegram topic for job notifications', async () => {
    const job = makeJob({ notification_routes: undefined });
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        opsRepository: opsRepository as never,
        runAgent: vi.fn(async () => ({
          status: 'success',
          result: 'runtime flow completed',
        })) as never,
      },
      'tg:scheduler',
    );

    expect(sendMessage.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'tg:scheduler',
          expect.stringContaining('**▶️ Running** · Daily summary'),
          { threadId: 'thread-scheduled' },
        ],
        [
          'tg:scheduler',
          expect.stringContaining('**✅ Completed** · Daily summary'),
          expect.objectContaining({ threadId: 'thread-scheduled' }),
        ],
      ]),
    );
  });

  it('uses a bounded tail summary for long streamed scheduled job output', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);
    const head = `HEAD-${'a'.repeat(1_000)}`;
    const middle = 'b'.repeat(4_500);
    const tail = `TAIL-${'z'.repeat(100)}`;
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({ status: 'success', result: head } as never);
      await onStream({ status: 'success', result: middle } as never);
      await onStream({ status: 'success', result: tail } as never);
      return {
        status: 'success',
        result: `${head}${middle}${tail}`,
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        opsRepository: opsRepository as never,
        collectSessionMemory: vi.fn(async () => ({ saved: 1 })) as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    const completionSummary = vi.mocked(opsRepository.completeJobRun).mock
      .calls[0]?.[2];
    expect(completionSummary).toBeTypeOf('string');
    expect(completionSummary).toHaveLength(500);
    expect(completionSummary).toContain('[output truncated; showing tail]');
    expect(completionSummary).not.toContain('HEAD-');

    const memoryResult =
      collectJobCompletionMemoryMock.mock.calls[0]?.[0].result;
    expect(memoryResult).toBeTypeOf('string');
    expect(memoryResult).toHaveLength(4_000);
    expect(memoryResult).toContain('[output truncated; showing tail]');
    expect(memoryResult).not.toContain('HEAD-');
    expect(memoryResult).toContain('TAIL-');

    expect(sendMessage).toHaveBeenLastCalledWith(
      'tg:scheduler',
      expect.not.stringContaining('HEAD-'),
      expect.objectContaining({ threadId: 'thread-scheduled' }),
    );
    expect(sendMessage).toHaveBeenLastCalledWith(
      'tg:scheduler',
      expect.not.stringContaining('[output truncated; showing tail]'),
      expect.objectContaining({ threadId: 'thread-scheduled' }),
    );
  });

  it('keeps scheduler assistant output out of notification routes', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);
    const sendStreamingChunk = vi.fn(async () => true);
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        result: 'first visible chunk ',
      } as never);
      await onStream({
        status: 'success',
        result: 'second visible chunk',
      } as never);
      return {
        status: 'success',
        result: 'first visible chunk second visible chunk',
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        sendStreamingChunk,
        resetStreaming: vi.fn(),
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(sendStreamingChunk).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(
      'tg:scheduler',
      'first visible chunk second visible chunk',
      { threadId: 'thread-scheduled' },
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:scheduler',
      expect.stringContaining('first visible chunk second visible chunk'),
      expect.objectContaining({ threadId: 'thread-scheduled' }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      'first visible chunk second visible chunk',
      null,
    );
  });

  it('publishes scheduled runner heartbeat events with status payload', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'job.heartbeat',
            payload: {
              currentTool: 'Bash',
              lastActivityAgoMs: 16_000,
              pendingPermissionRequests: 1,
              totalToolCalls: 3,
            },
          },
        ],
      } as never);
      return {
        status: 'success',
        result: 'done',
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.heartbeat',
        jobId: 'job-1',
        payload: {
          currentTool: 'Bash',
          lastActivityAgoMs: 16_000,
          pendingPermissionRequests: 1,
          totalToolCalls: 3,
        },
      }),
    );
  });

  it('fails required Browser preflight before spawning when Browser is not available', async () => {
    const job = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const runAgent = vi.fn();

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(opsRepository.completeJobRun).not.toHaveBeenCalled();
    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        setup_state: expect.objectContaining({
          state: 'missing_capability',
        }),
      }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.setup_required',
        payload: expect.objectContaining({
          setup_state: 'missing_capability',
        }),
      }),
    );
  });

  it('surfaces setup blockers without queuing a target-agent recovery turn', async () => {
    let storedJob = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = {
      ...makeOpsRepository(storedJob),
      getJobById: vi.fn(async () => storedJob),
      updateJob: vi.fn(async (_jobId: string, updates: Partial<Job>) => {
        storedJob = { ...storedJob, ...updates };
      }),
      getAgentTurnContext: vi.fn(async () => ({
        appId: 'default',
        agentId: 'agent:scheduler_agent',
        agentSessionId: 'agent-session:scheduler',
        externalSessionId: 'provider-session:recovery',
      })),
      createSessionAgentRun: vi.fn(async () => 'agent-run:recovery-1'),
      completeSessionAgentRun: vi.fn(async () => undefined),
    };
    const queue = {
      enqueueTask: vi.fn(),
    };
    const runAgent = vi.fn(async () => ({
      status: 'success',
      result: 'Recovery request sent.',
    }));

    await runJob(
      storedJob,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: queue as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(queue.enqueueTask).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(storedJob.recovery_intent).toBeUndefined();
    expect(storedJob.setup_state).toMatchObject({
      state: 'missing_capability',
    });
  });

  it('pauses after claim when final readiness fails before model spawn', async () => {
    const job = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
      next_run: '2026-05-08T00:00:00.000Z',
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    toolRepository.listAgentToolBindings = vi
      .fn()
      .mockResolvedValueOnce([
        {
          toolId: 'Browser',
          appId: 'default',
          agentId: 'agent:scheduler_agent',
          status: 'active',
        },
      ])
      .mockResolvedValueOnce([]);
    const runAgent = vi.fn();

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.claimDueJobRunStart).toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        next_run: null,
      }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      null,
      expect.stringContaining('Missing tool access requirement before run'),
    );
  });

  it('does not repeat setup notifications for an unchanged blocker fingerprint', async () => {
    const initialJob = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const readiness = await evaluateJobReadiness({
      job: initialJob,
      appId: 'default',
      agentId: 'agent:scheduler_agent',
      clock: { now: () => '2026-05-08T00:00:00.000Z' },
    });
    const job = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
      setup_state: {
        ...readiness.setupState,
        notified_fingerprint: readiness.setupState.fingerprint,
      },
    });
    const opsRepository = makeOpsRepository(job);
    const runAgent = vi.fn();
    const sendMessage = vi.fn(async () => undefined);

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: sendMessage as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.setup_required',
        payload: expect.objectContaining({
          notified: false,
        }),
      }),
    );
  });

  it('completes when declared Browser access is available but unused', async () => {
    const job = makeJob({
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    const runAgent = vi.fn(async () => ({
      status: 'success',
      result: 'done without browser',
    }));

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        getBrowserStatus: vi.fn(async () => ({ hasState: true })),
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runAgent).toHaveBeenCalled();
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      'done without browser',
      null,
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.tool_activity',
        payload: expect.objectContaining({
          phase: 'tool_access_preflight',
          tool_access_requirements: ['Browser'],
          missing_tool_access_requirements: [],
          ok: true,
        }),
      }),
    );
  });

  it('does not require every declared RunCommand rule to be exercised', async () => {
    const job = makeJob({
      access_requirements: [
        {
          target: { kind: 'tool_rule', rule: 'RunCommand(acme records get *)' },
        },
        {
          target: {
            kind: 'tool_rule',
            rule: 'RunCommand(acme records update *)',
          },
        },
      ],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository([
      'RunCommand(acme records get *)',
      'RunCommand(acme records update *)',
    ]);
    const runAgent = vi.fn(async (_group, _input) => {
      expect(_input.toolAccessRequirements).toEqual([
        'RunCommand(acme records get *)',
        'RunCommand(acme records update *)',
      ]);
      return { status: 'success', result: 'partial command work' };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      'partial command work',
      null,
    );
  });

  it('passes canonical absolute CLI requirements into scheduled runner prompts', async () => {
    const job = makeJob({
      access_requirements: [
        {
          target: { kind: 'tool_rule', rule: 'RunCommand(acme records get *)' },
        },
      ],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository([
      'RunCommand(/opt/homebrew/bin/acme records get *)',
    ]);
    const runAgent = vi.fn(async (_group, _input) => {
      expect(_input.toolAccessRequirements).toEqual([
        'RunCommand(/opt/homebrew/bin/acme records get *)',
      ]);
      return { status: 'success', result: 'sheet read complete' };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runAgent).toHaveBeenCalled();
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.tool_activity',
        payload: expect.objectContaining({
          phase: 'tool_access_preflight',
          tool_access_requirements: [
            'RunCommand(/opt/homebrew/bin/acme records get *)',
          ],
          missing_tool_access_requirements: [],
          ok: true,
        }),
      }),
    );
  });

  it('fails before launch when a declared RunCommand access requirement is missing', async () => {
    const job = makeJob({
      access_requirements: [
        {
          target: { kind: 'tool_rule', rule: 'RunCommand(acme records get *)' },
        },
        {
          target: {
            kind: 'tool_rule',
            rule: 'RunCommand(acme records update *)',
          },
        },
      ],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository([
      'RunCommand(acme records get *)',
    ]);
    const runAgent = vi.fn(async () => ({
      status: 'success',
      result: 'unused',
    }));

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'paused',
        pause_reason: 'Setup required',
        setup_state: expect.objectContaining({
          state: 'missing_capability',
          blockers: [
            expect.objectContaining({
              requirementId: 'RunCommand(acme records update *)',
            }),
          ],
        }),
      }),
    );
    expect(opsRepository.completeJobRun).not.toHaveBeenCalled();
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.setup_required',
        payload: expect.objectContaining({
          setup_state: 'missing_capability',
          blockers: [
            expect.objectContaining({
              requirement_id: 'RunCommand(acme records update *)',
            }),
          ],
        }),
      }),
    );
  });

  it('keeps explicit tool denial as terminal error', async () => {
    const job = makeJob({
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'job.tool_activity',
            payload: {
              phase: 'permission_wait',
              tool: 'Bash',
              ok: false,
              reason: 'Tool not on autonomous run allowlist: RunCommand.',
              recovery_action:
                'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
            },
          },
          {
            eventType: 'job.tool_activity',
            payload: {
              phase: 'permission_denied',
              tool: 'Bash',
              ok: false,
              reason: 'Autonomous permission approval is disabled.',
            },
          },
        ],
      } as never);
      return { status: 'success', result: 'blocked' };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        getBrowserStatus: vi.fn(async () => ({ hasState: true })),
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      'blocked',
      expect.stringContaining('Permission denied for Bash'),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      'blocked',
      expect.not.stringContaining('post-run usage'),
    );
  });

  it('pauses recurring jobs for setup when a durable tool denial is followed by a generic SDK error', async () => {
    const job = makeJob({
      schedule_type: 'recurring',
      schedule: '*/15 * * * *',
      next_run: '2026-05-08T00:00:00.000Z',
      max_consecutive_failures: 1,
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'job.tool_activity',
            payload: {
              phase: 'permission_wait',
              tool: 'Bash',
              ok: false,
              reason:
                'Tool not on autonomous run allowlist: RunCommand. Bash leaf ls scripts did not match any scoped autonomous rule.',
              recovery_action:
                'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
            },
          },
          {
            eventType: 'job.tool_activity',
            payload: {
              phase: 'permission_denied',
              tool: 'Bash',
              ok: false,
              reason:
                'Autonomous permission approval is disabled for unattended jobs.',
            },
          },
        ],
      } as never);
      return {
        status: 'error',
        error:
          'Claude Code returned an error result: [ede_diagnostic] stop_reason=tool_use; AxiosError: Request failed with status code 403',
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        getBrowserStatus: vi.fn(async () => ({ hasState: true })),
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'paused',
        next_run: null,
        pause_reason: 'Setup required',
        setup_state: expect.objectContaining({
          state: 'missing_capability',
          blockers: [
            expect.objectContaining({
              requirementType: 'tool',
              requirementId: 'RunCommand',
            }),
          ],
        }),
      }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      null,
      expect.stringContaining('Claude Code returned an error result'),
    );
    expect(opsRepository.completeJobRun).not.toHaveBeenCalledWith(
      expect.any(String),
      'dead_lettered',
      expect.anything(),
      expect.anything(),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.setup_required',
        payload: expect.objectContaining({
          setup_state: 'missing_capability',
        }),
      }),
    );
  });

  it('keeps browser activity diagnostics without enforcing use after the run', async () => {
    const job = makeJob({
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'job.tool_activity',
            payload: {
              tool: 'Browser',
              public_tool: 'browser_open',
              action: 'navigate',
              ok: true,
            },
          },
        ],
      } as never);
      return {
        status: 'success',
        result: 'browser done',
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        getBrowserStatus: vi.fn(async () => ({ hasState: true })),
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      'browser done',
      null,
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.completed',
        payload: expect.objectContaining({
          diagnostics: expect.objectContaining({
            browser_activity_count: 1,
          }),
        }),
      }),
    );
  });

  it('closes the dedicated browser profile after a Browser job reaches terminal state', async () => {
    const job = makeJob({
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    const closeBrowserToolBackends = vi.fn(async () => undefined);
    const closeBrowserSession = vi.fn(async () => ({
      closed: true,
      reason: 'terminated',
      elapsedMs: 12,
    }));

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        getBrowserStatus: vi.fn(async () => ({ hasState: true })),
        closeBrowserToolBackends,
        closeBrowserSession,
        runAgent: vi.fn(async () => ({
          status: 'success',
          result: 'browser done',
        })) as never,
      },
      'tg:scheduler',
    );

    expect(closeBrowserToolBackends).toHaveBeenCalledWith(
      expect.stringMatching(/^c-scheduler_agent-/),
    );
    expect(closeBrowserSession).toHaveBeenCalledWith(
      expect.stringMatching(/^c-scheduler_agent-/),
    );
    expect(opsRepository.listRecentJobEvents).not.toHaveBeenCalled();
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.tool_activity',
        payload: expect.objectContaining({
          phase: 'browser_cleanup',
          tool: 'Browser',
          ok: true,
          reason: 'terminated',
        }),
      }),
    );
  });

  it('prelaunches the dedicated browser profile before a Browser job starts the runner', async () => {
    const job = makeJob({
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    const order: string[] = [];
    const openBrowserSession = vi.fn(async (profileName: string) => {
      order.push('browser');
      return {
        profile: profileName,
        profileName,
        running: true,
        cdpReady: true,
        pid: 123,
        port: 456,
      };
    });
    const runAgent = vi.fn(async () => {
      order.push('runner');
      return {
        status: 'success',
        result: 'browser done',
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        getBrowserStatus: vi.fn(async () => ({ hasState: true })),
        openBrowserSession,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(order).toEqual(['browser', 'runner']);
    expect(openBrowserSession).toHaveBeenCalledWith(
      expect.stringMatching(/^c-scheduler_agent-/),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.tool_activity',
        payload: expect.objectContaining({
          phase: 'browser_prelaunch',
          tool: 'Browser',
          public_tool: 'browser_open',
          action: 'open',
          ok: true,
        }),
      }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.completed',
        payload: expect.objectContaining({
          diagnostics: expect.objectContaining({
            browser_activity_count: 1,
          }),
        }),
      }),
    );
  });

  it('pauses a Browser job for setup when browser prelaunch fails', async () => {
    const job = makeJob({
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    const openBrowserSession = vi.fn(async () => {
      throw new Error('Chrome launch failed');
    });
    const runAgent = vi.fn(async () => ({
      status: 'success',
      result: 'should not run',
    }));

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        getBrowserStatus: vi.fn(async () => ({ hasState: true })),
        openBrowserSession,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(opsRepository.updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: 'paused',
        next_run: null,
        pause_reason: 'Setup required',
        setup_state: expect.objectContaining({
          state: 'browser_login_may_be_required',
          blockers: expect.arrayContaining([
            expect.objectContaining({
              requirementType: 'browser',
              requirementId: 'Browser',
              nextAction: expect.stringContaining('gantry browser status'),
            }),
          ]),
        }),
      }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      null,
      expect.stringContaining('Setup required: Browser launch failed'),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.failed',
        payload: expect.objectContaining({
          pause_reason: 'Setup required',
        }),
      }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.setup_required',
        payload: expect.objectContaining({
          setup_state: 'browser_login_may_be_required',
          blockers: expect.arrayContaining([
            expect.objectContaining({
              requirement_type: 'browser',
              requirement_id: 'Browser',
            }),
          ]),
        }),
      }),
    );
  });

  it('keeps Browser activity diagnostics when a required-Browser run fails later', async () => {
    const job = makeJob({
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
    const opsRepository = makeOpsRepository(job);
    const toolRepository = makeToolRepository(['Browser']);
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'job.tool_activity',
            payload: {
              tool: 'Browser',
              public_tool: 'browser_open',
              action: 'navigate',
              ok: true,
            },
          },
          {
            eventType: 'job.tool_activity',
            payload: {
              tool: 'Browser',
              public_tool: 'browser_inspect',
              action: 'snapshot',
              ok: true,
            },
          },
        ],
      } as never);
      return {
        status: 'error',
        error:
          'Scheduled job made no runner or tool progress for 10 min. lastTool=SandboxNetworkAccess',
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        getToolRepository: () => toolRepository as never,
        getBrowserStatus: vi.fn(async () => ({ hasState: true })),
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      null,
      expect.stringContaining('Scheduled job made no runner or tool progress'),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.failed',
        payload: expect.objectContaining({
          diagnostics: expect.objectContaining({
            browser_activity_count: 2,
          }),
        }),
      }),
    );
  });

  it('forwards non-heartbeat scheduled runner runtime events', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'task.notification',
            payload: { taskId: 'task-1', status: 'started' },
          },
          {
            eventType: 'permission.requested',
            payload: { toolName: 'Bash' },
          },
          {
            eventType: 'sandbox.blocked',
            payload: { toolName: 'Bash', reason: 'protected path' },
          },
        ],
      } as never);
      return { status: 'success', result: 'done' };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
    );

    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task.notification',
        payload: { taskId: 'task-1', status: 'started' },
      }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.requested',
        payload: { toolName: 'Bash' },
      }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'sandbox.blocked',
        payload: { toolName: 'Bash', reason: 'protected path' },
      }),
    );
  });

  it('records scheduler sandbox metadata and final startup failure events', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const runnerSandboxProvider = {
      id: 'sandbox_runtime',
      enforcing: true,
    };
    const runAgent = vi.fn(async () => ({
      status: 'error',
      result: null,
      error:
        'Sandbox startup failed: sandbox unavailable. The run did not start.',
      runtimeEvents: [
        {
          eventType: 'sandbox.blocked',
          payload: {
            provider: 'sandbox_runtime',
            enforcing: true,
            message: 'sandbox unavailable',
          },
        },
      ],
    }));

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
        runnerSandboxProvider: runnerSandboxProvider as never,
      },
      'tg:scheduler',
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        runnerSandboxProvider,
      }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.started',
        payload: expect.objectContaining({
          sandbox_provider: 'sandbox_runtime',
          sandbox_enforcing: true,
        }),
      }),
    );
    expect(runtimeStoreMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'sandbox.blocked',
        payload: expect.objectContaining({
          provider: 'sandbox_runtime',
          enforcing: true,
        }),
      }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      null,
      expect.stringContaining('Sandbox startup failed'),
    );
  });

  describe('model-family runtime failover (Phase 3)', () => {
    it('fails over to the next configured provider UNDER THE SAME lease', async () => {
      const job = makeJob({ model: 'gpt-oss' });
      const opsRepository = {
        ...makeOpsRepository(job),
        getAgentTurnContext: vi.fn(async () => ({
          appId: 'default',
          agentId: 'agent:scheduler_agent',
          agentSessionId: 'agent-session:scheduler',
        })),
        createSessionAgentRun: vi.fn(async () => 'agent-run:job-1'),
      };
      // gpt-oss family: members groq-oss (groq) + cerebras. Both configured ->
      // candidates [groq-oss, cerebras].
      getConfiguredModelProvidersForAppMock.mockResolvedValue(
        new Set(['groq', 'cerebras']),
      );
      const runAgent = vi
        .fn()
        // First candidate (groq-oss) returns a 401 before any streamed output.
        .mockResolvedValueOnce({
          status: 'error',
          result: null,
          error: 'API Error: 401 invalid api key',
        })
        // Second candidate (cerebras) succeeds.
        .mockResolvedValueOnce({
          status: 'success',
          result: 'second provider reply',
        });

      await runJob(
        job,
        {
          conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
          queue: {} as never,
          onProcess: vi.fn(),
          sendMessage: vi.fn(async () => undefined) as never,
          opsRepository: opsRepository as never,
          runAgent: runAgent as never,
          executionAdapter: {
            id: 'anthropic:claude-agent-sdk',
            prepare: vi.fn(),
          } as never,
        },
        'tg:scheduler',
      );

      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(runAgent.mock.calls[0][1]).toMatchObject({ model: 'groq-oss' });
      expect(runAgent.mock.calls[1][1]).toMatchObject({ model: 'cerebras' });
      // SAME lease across both attempts: no re-claim, same lease token + fencing.
      expect(opsRepository.claimDueJobRunStart).toHaveBeenCalledTimes(1);
      expect(runAgent.mock.calls[0][1]).toMatchObject({
        runLeaseToken: 'lease-token-1',
        runLeaseFencingVersion: 1,
      });
      expect(runAgent.mock.calls[1][1]).toMatchObject({
        runLeaseToken: 'lease-token-1',
        runLeaseFencingVersion: 1,
      });
      // Terminal write is a single completed run under the same lease.
      expect(opsRepository.completeJobRun).toHaveBeenCalledTimes(1);
      expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
        expect.any(String),
        'completed',
        expect.stringContaining('second provider reply'),
        null,
      );
      // The jobs lane emits RUN_FAILOVER for observability (parity with the live
      // lane): from/to model captured, reason carries the eligibility-class error.
      const failoverEvent = runtimeStoreMock.publish.mock.calls.find(
        ([event]) => event?.eventType === 'run.failover',
      )?.[0];
      expect(failoverEvent).toBeDefined();
      expect(failoverEvent?.payload).toMatchObject({
        fromModel: 'groq-oss',
        toModel: 'cerebras',
      });
      expect(String(failoverEvent?.payload?.reason)).toContain('401');
    });

    it('finalizes failed when every candidate fails (eligible errors, no stream)', async () => {
      const job = makeJob({ model: 'gpt-oss' });
      const opsRepository = {
        ...makeOpsRepository(job),
        getAgentTurnContext: vi.fn(async () => ({
          appId: 'default',
          agentId: 'agent:scheduler_agent',
          agentSessionId: 'agent-session:scheduler',
        })),
        createSessionAgentRun: vi.fn(async () => 'agent-run:job-1'),
      };
      getConfiguredModelProvidersForAppMock.mockResolvedValue(
        new Set(['groq', 'cerebras']),
      );
      const runAgent = vi.fn(async () => ({
        status: 'error',
        result: null,
        error: 'API Error: 503 service unavailable',
      }));

      await runJob(
        job,
        {
          conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
          queue: {} as never,
          onProcess: vi.fn(),
          sendMessage: vi.fn(async () => undefined) as never,
          opsRepository: opsRepository as never,
          runAgent: runAgent as never,
          executionAdapter: {
            id: 'anthropic:claude-agent-sdk',
            prepare: vi.fn(),
          } as never,
        },
        'tg:scheduler',
      );

      // Both candidates attempted, then finalized failed (single terminal write).
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(opsRepository.completeJobRun).toHaveBeenCalledTimes(1);
      expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        null,
        expect.stringContaining('503'),
      );
    });
  });
});
