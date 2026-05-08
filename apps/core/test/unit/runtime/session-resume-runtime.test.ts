import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentSessionRepository } from '@core/domain/repositories/ops-repo.js';
import {
  completeSuccessfulRuntimeSessionRun,
  completeFailedRuntimeSessionRun,
  RUNTIME_RESULT_SUMMARY_MAX_CHARS,
  summarizeRuntimeResultForPersistence,
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
});
