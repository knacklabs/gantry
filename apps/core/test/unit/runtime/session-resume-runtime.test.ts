import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentSessionRepository } from '@core/domain/repositories/ops-repo.js';
import {
  createRuntimeResultSummaryAccumulator,
  completeSuccessfulRuntimeSessionRun,
  completeFailedRuntimeSessionRun,
  RUNTIME_RESULT_SUMMARY_MAX_CHARS,
  summarizeRuntimeResultForPersistence,
  truncateRuntimeResultSummary,
} from '@core/runtime/session-resume-runtime.js';

describe('session-resume-runtime', () => {
  it('redacts provider session handles from persisted summaries', () => {
    const summary = summarizeRuntimeResultForPersistence(
      [
        'framed {"newSessionId":"json-new-handle","providerSessionId":"provider-session:json-secret","externalSessionId":"claude-session-json-secret","session_id":"snake-json-handle"}',
        'sessionId=session-inline-handle',
        'latestProviderSessionId latest-whitespace-handle',
        'provider-session:standalone-secret',
        'claude-session-standalone-secret',
      ].join(' '),
    ) as string;

    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('json-new-handle');
    expect(summary).not.toContain('provider-session:json-secret');
    expect(summary).not.toContain('claude-session-json-secret');
    expect(summary).not.toContain('snake-json-handle');
    expect(summary).not.toContain('session-inline-handle');
    expect(summary).not.toContain('latest-whitespace-handle');
    expect(summary).not.toContain('provider-session:standalone-secret');
    expect(summary).not.toContain('claude-session-standalone-secret');
  });

  it('caps oversized failed agent run error summaries before persistence', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;
    const errorSummary = `HEAD-START${'x'.repeat(
      RUNTIME_RESULT_SUMMARY_MAX_CHARS + 250,
    )}TAIL-END`;

    await completeFailedRuntimeSessionRun({
      ops,
      runId: 'run-1',
      errorSummary,
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.errorSummary as string;
    expect(summary.length).toBeLessThanOrEqual(
      RUNTIME_RESULT_SUMMARY_MAX_CHARS,
    );
    expect(summary).toMatch(/^\[output truncated; showing tail\]\n/);
    expect(summary).not.toContain('HEAD-START');
    expect(summary.endsWith('TAIL-END')).toBe(true);
  });

  it('does not emit marker-only summaries when max chars cannot hold marker and content', () => {
    const accumulator = createRuntimeResultSummaryAccumulator({ maxChars: 0 });
    accumulator.append('important body');

    expect(accumulator.snapshot()).toBeNull();
  });

  it('keeps content instead of marker-only summaries for tiny truncation limits', () => {
    expect(truncateRuntimeResultSummary('important body', 8)).toBe(
      'important body',
    );
    expect(truncateRuntimeResultSummary('important body', 8)).not.toBe(
      '[output truncated; showing tail]',
    );
  });

  it('redacts completion summaries before storing successful runs', async () => {
    const completeSessionAgentRun = vi.fn().mockResolvedValue(undefined);
    const ops = {
      completeSessionAgentRun,
    } as unknown as RuntimeAgentSessionRepository;

    await completeSuccessfulRuntimeSessionRun({
      ops,
      group: { name: 'Main', folder: 'main_agent' } as never,
      runId: 'run-2',
      result:
        'ok {"newSessionId":"json-success-handle"} sessionId=session-inline-success provider-session:standalone-success',
    });

    expect(completeSessionAgentRun).toHaveBeenCalledTimes(1);
    const completion = completeSessionAgentRun.mock.calls[0][0];
    const summary = completion.resultSummary as string;
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('json-success-handle');
    expect(summary).not.toContain('session-inline-success');
    expect(summary).not.toContain('provider-session:standalone-success');
  });

  it('persists provider resume handles under the job-owned session scope', async () => {
    const setSession = vi.fn().mockResolvedValue(true);
    const ops = {
      setSession,
    } as unknown as RuntimeAgentSessionRepository;

    await completeSuccessfulRuntimeSessionRun({
      ops,
      group: { name: 'Scheduler', folder: 'scheduler_agent' } as never,
      chatJid: 'tg:scheduler',
      threadId: 'topic-1',
      conversationKind: 'channel',
      jobId: 'job-1',
      agentSessionId: 'agent-session:job-1',
      providerSessionId: 'claude-session-job-1',
      result: 'ok',
    });

    expect(setSession).toHaveBeenCalledWith(
      'scheduler_agent',
      'claude-session-job-1',
      'topic-1',
      expect.objectContaining({
        conversationJid: 'tg:scheduler',
        conversationKind: 'channel',
        jobId: 'job-1',
        expectedAgentSessionId: 'agent-session:job-1',
      }),
    );
  });
});
