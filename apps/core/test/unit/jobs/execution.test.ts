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
    linked_sessions: ['tg:scheduler'],
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
    execution_mode: 'serialized',
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
    claimDueJobRunStart: vi.fn(async () => true),
    updateJob: vi.fn(async () => undefined),
    completeJobRun: vi.fn(async () => undefined),
    markJobRunNotified: vi.fn(async () => undefined),
  };
}

describe('jobs/execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      'serialized',
    );

    const completionSummary = vi.mocked(opsRepository.completeJobRun).mock
      .calls[0]?.[2];
    expect(completionSummary).toContain('[REDACTED]');
    expect(completionSummary).not.toContain('provider-session:raw-result');
    expect(completionSummary).not.toContain('claude-session-result');
    expect(completionSummary).not.toContain('result-inline');
    expect(completionSummary).not.toContain('json-result');

    const completionMessage = sendMessage.mock.calls.at(-1)?.[1] as string;
    expect(completionMessage).toContain('Scheduler completed: Daily summary');
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
      'serialized',
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
    expect(failureMessage).toContain('Scheduler dead-lettered: Daily summary');
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
      'serialized',
    );

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'tg:scheduler',
      expect.stringContaining('Scheduler started: Daily summary'),
      { threadId: 'thread-scheduled' },
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'tg:scheduler',
      'actual job result',
      { threadId: 'thread-scheduled' },
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      3,
      'tg:scheduler',
      expect.stringContaining('Scheduler completed: Daily summary'),
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

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        opsRepository: opsRepository as never,
        collectSessionMemory: vi.fn(async () => ({ saved: 0 })) as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
      'serialized',
    );

    expect(opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentFolder: 'scheduler_agent',
        conversationJid: 'tg:scheduler',
        threadId: 'thread-scheduled',
        conversationKind: undefined,
        memoryUserId: undefined,
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
      'serialized',
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

  it('delivers streamed scheduled job chunks and finalizes streaming state', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);
    const sendStreamingChunk = vi.fn(async () => true);
    const resetStreaming = vi.fn();
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
        resetStreaming,
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
      'serialized',
    );

    expect(resetStreaming).toHaveBeenCalledWith('tg:scheduler');
    expect(sendStreamingChunk).toHaveBeenNthCalledWith(
      1,
      'tg:scheduler',
      'first visible chunk ',
      { threadId: 'thread-scheduled' },
    );
    expect(sendStreamingChunk).toHaveBeenNthCalledWith(
      2,
      'tg:scheduler',
      'second visible chunk',
      { threadId: 'thread-scheduled' },
    );
    expect(sendStreamingChunk).toHaveBeenNthCalledWith(3, 'tg:scheduler', '', {
      threadId: 'thread-scheduled',
      done: true,
    });
    expect(sendMessage).not.toHaveBeenCalledWith(
      'tg:scheduler',
      'first visible chunk second visible chunk',
      { threadId: 'thread-scheduled' },
    );
    expect(opsRepository.completeJobRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      'first visible chunk second visible chunk',
      null,
    );
  });

  it('redacts provider session handles before delivering streamed scheduler output chunks', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const sendStreamingChunk = vi.fn(async () => true);
    const sensitiveChunk =
      'visible-start provider-session:stream-handle keep claude-session-stream-handle sessionId=inline-stream {"newSessionId":"json-stream"} visible-end';
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({ status: 'success', result: sensitiveChunk } as never);
      return {
        status: 'success',
        result: sensitiveChunk,
      };
    });

    await runJob(
      job,
      {
        conversationRoutes: () => ({ 'tg:scheduler': makeRoute() }),
        queue: {} as never,
        onProcess: () => {},
        sendMessage: vi.fn(async () => undefined) as never,
        sendStreamingChunk,
        resetStreaming: vi.fn(),
        opsRepository: opsRepository as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
      'serialized',
    );

    const streamedCall = sendStreamingChunk.mock.calls.find(
      ([, text]) => text === sensitiveChunk,
    );
    expect(streamedCall).toBeUndefined();
    const deliveredChunk = sendStreamingChunk.mock.calls[0]?.[1] as string;
    expect(deliveredChunk).toContain('visible-start');
    expect(deliveredChunk).toContain('visible-end');
    expect(deliveredChunk).toContain('[REDACTED]');
    expect(deliveredChunk).not.toContain('provider-session:stream-handle');
    expect(deliveredChunk).not.toContain('claude-session-stream-handle');
    expect(deliveredChunk).not.toContain('sessionId=inline-stream');
    expect(deliveredChunk).not.toContain('"newSessionId":"json-stream"');
  });

  it('falls back to full result delivery when streamed scheduled job chunks are not delivered', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);
    const sendStreamingChunk = vi.fn(async () => false);
    const resetStreaming = vi.fn();
    const head = `FULL-HEAD-${'a'.repeat(900)}`;
    const middle = 'b'.repeat(4_500);
    const tail = `FULL-TAIL-${'z'.repeat(120)}`;
    const fullResult = `${head}${middle}${tail}`;
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({ status: 'success', result: head } as never);
      await onStream({ status: 'success', result: middle } as never);
      await onStream({ status: 'success', result: tail } as never);
      return {
        status: 'success',
        result: fullResult,
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
        resetStreaming,
        opsRepository: opsRepository as never,
        collectSessionMemory: vi.fn(async () => ({ saved: 1 })) as never,
        runAgent: runAgent as never,
      },
      'tg:scheduler',
      'serialized',
    );

    expect(sendStreamingChunk).toHaveBeenCalledWith('tg:scheduler', head, {
      threadId: 'thread-scheduled',
    });
    expect(sendStreamingChunk).toHaveBeenCalledWith('tg:scheduler', '', {
      threadId: 'thread-scheduled',
      done: true,
    });
    expect(resetStreaming).toHaveBeenCalledWith('tg:scheduler');
    const fallbackCall = sendMessage.mock.calls.find(
      ([jid, text]) =>
        jid === 'tg:scheduler' &&
        typeof text === 'string' &&
        text.includes('FULL-TAIL-'),
    );
    expect(fallbackCall).toBeDefined();
    const fallbackText = fallbackCall?.[1] as string;
    expect(fallbackText).toContain('[output truncated; showing tail]');
    expect(fallbackText).toContain('FULL-TAIL-');
    expect(fallbackText).not.toContain('FULL-HEAD-');
    expect(fallbackText.length).toBeLessThanOrEqual(
      RUNTIME_RESULT_SUMMARY_MAX_CHARS,
    );
    expect(fallbackText.length).toBe(RUNTIME_RESULT_SUMMARY_MAX_CHARS);

    const completionSummary = vi.mocked(opsRepository.completeJobRun).mock
      .calls[0]?.[2];
    expect(completionSummary).toBeTypeOf('string');
    expect(completionSummary).toHaveLength(500);
    expect(completionSummary).toContain('[output truncated; showing tail]');
    expect(completionSummary).not.toContain('FULL-HEAD-');
  });

  it('redacts provider session handles before fallback scheduler full-result delivery', async () => {
    const job = makeJob();
    const opsRepository = makeOpsRepository(job);
    const sendMessage = vi.fn(async () => undefined);
    const sendStreamingChunk = vi.fn(async () => false);
    const sensitiveHead = `safe-prefix provider-session:fallback-head claude-session-fallback-head sessionId=fallback-inline {"newSessionId":"fallback-json"} ${'x'.repeat(
      5_000,
    )}`;
    const sensitiveTail =
      ' provider-session:fallback-tail sessionId=tail-inline safe-suffix';
    const fullResult = `${sensitiveHead}${sensitiveTail}`;
    const runAgent = vi.fn(async (_group, _input, _onProcess, onStream) => {
      await onStream({ status: 'success', result: sensitiveHead } as never);
      await onStream({ status: 'success', result: sensitiveTail } as never);
      return {
        status: 'success',
        result: fullResult,
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
      'serialized',
    );

    const fallbackCall = sendMessage.mock.calls.find(
      ([, text]) => typeof text === 'string' && text.includes('safe-suffix'),
    );
    expect(fallbackCall).toBeDefined();
    const fallbackText = fallbackCall?.[1] as string;
    expect(fallbackText).toContain('safe-suffix');
    expect(fallbackText).toContain('[output truncated; showing tail]');
    expect(fallbackText.length).toBeLessThanOrEqual(
      RUNTIME_RESULT_SUMMARY_MAX_CHARS,
    );
    expect(fallbackText).toContain('[REDACTED]');
    expect(fallbackText).not.toContain('safe-prefix');
    expect(fallbackText).not.toContain('provider-session:fallback-head');
    expect(fallbackText).not.toContain('claude-session-fallback-head');
    expect(fallbackText).not.toContain('sessionId=fallback-inline');
    expect(fallbackText).not.toContain('provider-session:fallback-tail');
    expect(fallbackText).not.toContain('sessionId=tail-inline');
    expect(fallbackText).not.toContain('"newSessionId":"fallback-json"');
  });
});
