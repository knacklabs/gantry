import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AmbiguousDurableDeliveryError } from '@core/domain/messages/durable-delivery.js';
import type { ConversationRoute, Job } from '@core/domain/types.js';

const runtimeStoreMock = vi.hoisted(() => ({
  publish: vi.fn(async () => undefined),
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
    getEffectiveModelConfig: () => ({ model: undefined }),
  };
});

vi.mock('@core/platform/group-folder.js', () => ({
  resolveGroupFolderPath: () => '/tmp/myclaw-unit-scheduler-agent',
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
}));

vi.mock('@core/jobs/compact-memory.js', () => ({
  collectCompactBoundaryMemory: vi.fn(async () => undefined),
  collectJobCompletionMemory: vi.fn(async () => undefined),
}));

vi.mock('@core/jobs/system-jobs.js', () => ({
  MEMORY_DREAM_SYSTEM_PROMPT: '__system:memory_dream',
  handleSystemJob: vi.fn(async () => ({})),
}));

const { runJob } = await import('@core/jobs/execution.js');
const { RUNTIME_RESULT_SUMMARY_MAX_CHARS } =
  await import('@core/runtime/session-resume-runtime.js');
const compactMemory = await import('@core/jobs/compact-memory.js');
const collectJobCompletionMemoryMock = vi.mocked(
  compactMemory.collectJobCompletionMemory,
);

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
      groupScope: 'scheduler_agent',
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
  return {
    getJobById: vi.fn(async () => job),
    getJobRunById: vi.fn(async () => ({
      run_id: 'run-1',
      job_id: job.id,
      short_id: 1,
      status: 'running',
    })),
    claimDueJobRunStart: vi.fn(async () => true),
    createJobRun: vi.fn(async () => true),
    updateJob: vi.fn(async () => undefined),
    completeJobRun: vi.fn(async () => undefined),
    markJobRunNotified: vi.fn(async () => undefined),
  };
}

describe('jobs/execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records and notifies unresolved execution routes as dead-lettered runs', async () => {
    const job = makeJob({
      execution_context: {
        conversationJid: 'tg:missing',
        threadId: null,
        groupScope: 'scheduler_agent',
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
      expect.stringContaining('Paused after failures: Daily summary'),
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
    expect(completionMessage).toContain('Completed: Daily summary');
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

  it('dead-letters policy-denied recurring jobs with structured recovery events', async () => {
    const job = makeJob({
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: '2026-05-08T00:00:00.000Z',
    });
    const opsRepository = makeOpsRepository(job);
    const error =
      'Tool not on autonomous job allowlist: mcp__myclaw__browser_navigate. Recovery: request_permission { "toolName": "Browser" }';

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
        status: 'dead_lettered',
        pause_reason: 'Needs permission: mcp__myclaw__browser_navigate',
      }),
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'dead_lettered',
      null,
      expect.stringContaining('Tool not on autonomous job allowlist'),
    );
    const deniedEvent = runtimeStoreMock.publish.mock.calls.find(
      ([event]) => event?.eventType === 'job.tool_denied',
    )?.[0];
    expect(deniedEvent?.payload).toEqual(
      expect.objectContaining({
        denied_tool: 'mcp__myclaw__browser_navigate',
        recovery_kind: 'persistent_capability',
        recovery_action: expect.stringContaining('request_permission'),
      }),
    );
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
    expect(deadLetterUpdate?.pause_reason).toContain('[REDACTED]');
    expect(deadLetterUpdate?.pause_reason).not.toContain(
      'provider-session:raw-error',
    );
    expect(deadLetterUpdate?.pause_reason).not.toContain(
      'claude-session-error',
    );
    expect(deadLetterUpdate?.pause_reason).not.toContain('error-inline');
    expect(deadLetterUpdate?.pause_reason).not.toContain('json-error');

    const failureMessage = sendMessage.mock.calls.at(-1)?.[1] as string;
    expect(failureMessage).toContain('Paused after failures: Daily summary');
    expect(failureMessage).toContain('Outcome:');
    expect(failureMessage).toContain('Action:');
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
      '[REDACTED]',
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
      expect.stringContaining('Running: Daily summary'),
      { threadId: 'thread-scheduled' },
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'tg:scheduler',
      expect.stringContaining('Completed: Daily summary'),
      { threadId: 'thread-scheduled' },
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
          '<myclaw_memory_context trust="untrusted_data_only">job memory</myclaw_memory_context>',
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
          '<myclaw_memory_context trust="untrusted_data_only">job memory</myclaw_memory_context>',
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

  it('persists streamed provider resume handles in the job-owned session scope', async () => {
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

    expect(opsRepository.setSession).toHaveBeenCalledTimes(1);
    expect(opsRepository.setSession).toHaveBeenCalledWith(
      'scheduler_agent',
      'provider-session:streamed',
      'thread-scheduled',
      expect.objectContaining({
        conversationJid: 'tg:scheduler',
        conversationKind: undefined,
        memoryUserId: undefined,
        jobId: 'job-1',
        expectedAgentSessionId: 'agent-session:scheduler',
        expectedAgentSessionResetAt: null,
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
            listAgentToolBindings: vi.fn(async () => [
              { toolId: 'tool:Browser', status: 'active' },
            ]),
            getTool: vi.fn(async () => ({
              id: 'tool:Browser',
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
        allowedTools: ['Browser'],
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
    };
    const mcpServerRepository = {
      listAgentBindings: vi.fn(async () => [
        { serverId: 'mcp:github', status: 'active' },
        { serverId: 'mcp:legacy', status: 'inactive' },
      ]),
    };
    const skillArtifactStore = { readArtifact: vi.fn() };
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
        getSkillRepository: () => skillRepository as never,
        getMcpServerRepository: () => mcpServerRepository as never,
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
        selectedSkillIds: ['skill:release'],
        selectedMcpServerIds: ['mcp:github'],
      }),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        timeoutMs: 30000,
        credentialBroker,
        skillRepository,
        skillArtifactStore,
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
          expect.stringContaining('Running: Daily summary'),
          { threadId: 'thread-scheduled' },
        ],
        [
          'tg:scheduler',
          expect.stringContaining('Completed: Daily summary'),
          { threadId: 'thread-scheduled' },
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
      { threadId: 'thread-scheduled' },
    );
    expect(sendMessage).toHaveBeenLastCalledWith(
      'tg:scheduler',
      expect.stringContaining('[output truncated; showing tail]'),
      { threadId: 'thread-scheduled' },
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
      expect.stringContaining(
        'Outcome: first visible chunk second visible chunk',
      ),
      { threadId: 'thread-scheduled' },
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
});
