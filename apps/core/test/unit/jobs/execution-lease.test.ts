import { describe, expect, it, vi } from 'vitest';

import type { RunLease } from '@core/domain/ports/worker-coordination.js';
import {
  claimSchedulerRunLease,
  RUNNER_CONTROL_EVENT_WRITE_TIMEOUT_MS,
  settleSchedulerRunLease,
  startSchedulerRunLeaseHeartbeat,
} from '@core/jobs/execution-lease.js';
import {
  registerWorkerInstance,
  stopWorkerHeartbeat,
} from '@core/jobs/worker-identity.js';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    deps: {
      opsRepository: {
        settleJobRunLease: vi.fn(async () => true),
      },
    },
    currentJob: { id: 'job-1' },
    runId: 'run-1',
    leaseContext: {
      lease: {
        runId: 'run-1',
        jobId: 'job-1',
        workerInstanceId: 'worker-1',
        leaseToken: 'lease-token-1',
        fencingVersion: 1,
        status: 'active',
        claimedAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        heartbeatAt: '2026-06-10T00:00:00.000Z',
      },
      recordRunnerControlEvent: vi.fn(async () => undefined),
    },
    error: null,
    warn: vi.fn(),
    ...overrides,
  } as any;
}

function retryableJob() {
  return {
    id: 'job-1',
    schedule_type: 'interval',
    retry_backoff_ms: 5_000,
    max_retries: 3,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
  } as any;
}

describe('settleSchedulerRunLease', () => {
  it('records terminal control evidence after successful settlement', async () => {
    const input = baseInput();

    await expect(settleSchedulerRunLease(input)).resolves.toBe(true);

    expect(input.deps.opsRepository.settleJobRunLease).toHaveBeenCalledWith({
      runId: 'run-1',
      leaseToken: 'lease-token-1',
      workerInstanceId: 'worker-1',
      fencingVersion: 1,
      outcome: 'completed',
    });
    expect(input.leaseContext.recordRunnerControlEvent).toHaveBeenCalledWith(
      'terminal_state',
      {
        outcome: 'completed',
        fencingVersion: 1,
      },
    );
  });

  it('does not record terminal control evidence when settlement fails', async () => {
    const input = baseInput({
      deps: {
        opsRepository: {
          settleJobRunLease: vi.fn(async () => false),
        },
      },
    });

    await expect(settleSchedulerRunLease(input)).resolves.toBe(false);

    expect(input.leaseContext.recordRunnerControlEvent).not.toHaveBeenCalled();
  });
});

describe('startSchedulerRunLeaseHeartbeat', () => {
  it('signals lease loss and stops heartbeating when the lease is fenced', async () => {
    vi.useFakeTimers();
    try {
      const heartbeatRunLease = vi.fn(async () => false);
      const onLeaseLost = vi.fn();
      const input = baseInput({
        getCoordinationRepository: () => ({ heartbeatRunLease }),
        ttlMs: 60_000,
        onLeaseLost,
      });

      const heartbeat = startSchedulerRunLeaseHeartbeat(input);
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(20_000);
      heartbeat.stop();

      expect(heartbeatRunLease).toHaveBeenCalledTimes(1);
      expect(onLeaseLost).toHaveBeenCalledTimes(1);
      expect(input.warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', fencingVersion: 1 }),
        'Run lease heartbeat was fenced or expired',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps heartbeating when a lease heartbeat attempt throws', async () => {
    vi.useFakeTimers();
    try {
      const heartbeatRunLease = vi
        .fn()
        .mockRejectedValueOnce(new Error('db unavailable'))
        .mockResolvedValue(true);
      const onLeaseLost = vi.fn();
      const input = baseInput({
        getCoordinationRepository: () => ({ heartbeatRunLease }),
        ttlMs: 60_000,
        onLeaseLost,
      });

      const heartbeat = startSchedulerRunLeaseHeartbeat(input);
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(20_000);
      heartbeat.stop();

      expect(heartbeatRunLease).toHaveBeenCalledTimes(2);
      expect(onLeaseLost).not.toHaveBeenCalled();
      expect(input.warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', err: expect.any(Error) }),
        'Failed to heartbeat scheduler run lease',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not renew a stuck run beyond the scheduler deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-10T00:00:00.000Z'));
      const heartbeatRunLease = vi.fn(async () => true);
      const onLeaseLost = vi.fn();
      const input = baseInput({
        getCoordinationRepository: () => ({ heartbeatRunLease }),
        ttlMs: 90_000,
        deadlineMs: Date.now() + 60_000,
        onLeaseLost,
      });

      const heartbeat = startSchedulerRunLeaseHeartbeat(input);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      heartbeat.stop();

      expect(heartbeatRunLease).toHaveBeenCalledTimes(2);
      expect(heartbeatRunLease.mock.calls[0]?.[0]).toMatchObject({
        ttlMs: 60_000,
      });
      expect(heartbeatRunLease.mock.calls[1]?.[0]).toMatchObject({
        ttlMs: 30_000,
      });
      expect(onLeaseLost).toHaveBeenCalledTimes(1);
      expect(input.warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', fencingVersion: 1 }),
        'Run lease heartbeat stopped at scheduler deadline',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('claimSchedulerRunLease', () => {
  it('fails the claim when runner-control evidence hangs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T00:00:00.000Z'));
    const lease: RunLease = {
      runId: 'run-1',
      jobId: 'job-1',
      workerInstanceId: 'worker-1',
      leaseToken: 'lease-token-1',
      fencingVersion: 1,
      status: 'active',
      claimedAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2026-06-10T00:05:00.000Z',
      heartbeatAt: '2026-06-10T00:00:00.000Z',
    };
    try {
      await registerWorkerInstance({
        registerWorker: vi.fn(async () => undefined),
        heartbeatWorker: vi.fn(async () => true),
      } as any);
      const warn = vi.fn();
      const finalizeJobRunWithLease = vi.fn(async () => true);
      const claim = claimSchedulerRunLease({
        deps: {
          opsRepository: {
            claimDueJobRunStart: vi.fn(async () => lease),
            finalizeJobRunWithLease,
          },
          sendMessage: vi.fn(),
        } as any,
        currentJob: retryableJob(),
        runId: 'run-1',
        executionProviderId: 'anthropic:claude-agent-sdk' as any,
        workerId: 'main_agent',
        leaseOwner: '__scheduler__:main_agent:job-1',
        scheduledFor: '2026-06-10T00:00:00.000Z',
        startedAt: '2026-06-10T00:00:00.000Z',
        leaseExpiresAt: '2026-06-10T00:05:00.000Z',
        requireNextRun: false,
        getCoordinationRepository: () =>
          ({
            appendRunnerControlEvent: vi.fn(() => new Promise(() => {})),
          }) as any,
        warn,
      });

      const claimExpectation = expect(claim).rejects.toThrow(
        'Timed out appending runner control event: claimed',
      );
      await vi.advanceTimersByTimeAsync(RUNNER_CONTROL_EVENT_WRITE_TIMEOUT_MS);
      await claimExpectation;
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          runId: 'run-1',
          eventType: 'claimed',
        }),
        'Failed to append runner control event',
      );
      expect(finalizeJobRunWithLease).toHaveBeenCalledWith({
        jobId: 'job-1',
        runId: 'run-1',
        leaseToken: 'lease-token-1',
        workerInstanceId: 'worker-1',
        fencingVersion: 1,
        leaseOutcome: 'failed',
        runStatus: 'failed',
        resultSummary: null,
        errorSummary:
          'Scheduler run failed before runner-control evidence was persisted.',
        jobUpdates: {
          status: 'active',
          next_run: '2026-06-10T00:00:10.000Z',
          last_run: '2026-06-10T00:00:05.000Z',
          lease_run_id: null,
          lease_expires_at: null,
          consecutive_failures: 1,
          pause_reason: null,
        },
      });
    } finally {
      stopWorkerHeartbeat();
      vi.useRealTimers();
    }
  });

  it('fails the claim when runner-control evidence is fenced', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T00:00:00.000Z'));
    const lease: RunLease = {
      runId: 'run-1',
      jobId: 'job-1',
      workerInstanceId: 'worker-1',
      leaseToken: 'lease-token-1',
      fencingVersion: 1,
      status: 'active',
      claimedAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2026-06-10T00:05:00.000Z',
      heartbeatAt: '2026-06-10T00:00:00.000Z',
    };
    try {
      await registerWorkerInstance({
        registerWorker: vi.fn(async () => undefined),
        heartbeatWorker: vi.fn(async () => true),
      } as any);
      const finalizeJobRunWithLease = vi.fn(async () => true);
      await expect(
        claimSchedulerRunLease({
          deps: {
            opsRepository: {
              claimDueJobRunStart: vi.fn(async () => lease),
              finalizeJobRunWithLease,
            },
            sendMessage: vi.fn(),
          } as any,
          currentJob: retryableJob(),
          runId: 'run-1',
          executionProviderId: 'anthropic:claude-agent-sdk' as any,
          workerId: 'main_agent',
          leaseOwner: '__scheduler__:main_agent:job-1',
          scheduledFor: '2026-06-10T00:00:00.000Z',
          startedAt: '2026-06-10T00:00:00.000Z',
          leaseExpiresAt: '2026-06-10T00:05:00.000Z',
          requireNextRun: false,
          getCoordinationRepository: () =>
            ({
              appendRunnerControlEvent: vi.fn(async () => 'fenced'),
            }) as any,
          warn: vi.fn(),
        }),
      ).rejects.toThrow('Runner control event was not persisted: fenced');
      expect(finalizeJobRunWithLease).toHaveBeenCalledWith({
        jobId: 'job-1',
        runId: 'run-1',
        leaseToken: 'lease-token-1',
        workerInstanceId: 'worker-1',
        fencingVersion: 1,
        leaseOutcome: 'failed',
        runStatus: 'failed',
        resultSummary: null,
        errorSummary:
          'Scheduler run failed before runner-control evidence was persisted.',
        jobUpdates: {
          status: 'active',
          next_run: '2026-06-10T00:00:05.000Z',
          last_run: '2026-06-10T00:00:00.000Z',
          lease_run_id: null,
          lease_expires_at: null,
          consecutive_failures: 1,
          pause_reason: null,
        },
      });
    } finally {
      stopWorkerHeartbeat();
      vi.useRealTimers();
    }
  });

  it('does not abort terminal handling when terminal runner-control evidence hangs', async () => {
    vi.useFakeTimers();
    const lease: RunLease = {
      runId: 'run-1',
      jobId: 'job-1',
      workerInstanceId: 'worker-1',
      leaseToken: 'lease-token-1',
      fencingVersion: 1,
      status: 'active',
      claimedAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2026-06-10T00:05:00.000Z',
      heartbeatAt: '2026-06-10T00:00:00.000Z',
    };
    try {
      await registerWorkerInstance({
        registerWorker: vi.fn(async () => undefined),
        heartbeatWorker: vi.fn(async () => true),
      } as any);
      const warn = vi.fn();
      const appendRunnerControlEvent = vi
        .fn()
        .mockResolvedValueOnce('persisted')
        .mockImplementationOnce(() => new Promise(() => {}));
      const context = await claimSchedulerRunLease({
        deps: {
          opsRepository: {
            claimDueJobRunStart: vi.fn(async () => lease),
          },
          sendMessage: vi.fn(),
        } as any,
        currentJob: { id: 'job-1', consecutive_failures: 0 } as any,
        runId: 'run-1',
        executionProviderId: 'anthropic:claude-agent-sdk' as any,
        workerId: 'main_agent',
        leaseOwner: '__scheduler__:main_agent:job-1',
        scheduledFor: '2026-06-10T00:00:00.000Z',
        startedAt: '2026-06-10T00:00:00.000Z',
        leaseExpiresAt: '2026-06-10T00:05:00.000Z',
        requireNextRun: false,
        getCoordinationRepository: () =>
          ({
            appendRunnerControlEvent,
          }) as any,
        warn,
      });

      const terminalWrite = context!.recordRunnerControlEvent(
        'terminal_state',
        { outcome: 'completed' },
      );
      const terminalExpectation =
        expect(terminalWrite).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(RUNNER_CONTROL_EVENT_WRITE_TIMEOUT_MS);
      await terminalExpectation;
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          runId: 'run-1',
          eventType: 'terminal_state',
        }),
        'Failed to append runner control event',
      );
    } finally {
      stopWorkerHeartbeat();
      vi.useRealTimers();
    }
  });

  it('does not wait for recovered-run notification delivery', async () => {
    const lease: RunLease = {
      runId: 'run-1',
      jobId: 'job-1',
      workerInstanceId: 'worker-1',
      leaseToken: 'lease-token-1',
      fencingVersion: 2,
      recoveredFromExpiredLease: true,
      status: 'active',
      claimedAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2026-06-10T00:05:00.000Z',
      heartbeatAt: '2026-06-10T00:00:00.000Z',
    };
    try {
      await registerWorkerInstance({
        registerWorker: vi.fn(async () => undefined),
        heartbeatWorker: vi.fn(async () => true),
      } as any);
      const claim = claimSchedulerRunLease({
        deps: {
          opsRepository: {
            claimDueJobRunStart: vi.fn(async () => lease),
          },
          sendMessage: vi.fn(() => new Promise(() => {})),
        } as any,
        currentJob: {
          id: 'job-1',
          name: 'Job',
          consecutive_failures: 0,
          silent: false,
          notification_routes: [
            { conversationJid: 'tg:ops', threadId: null, label: 'Ops' },
          ],
        } as any,
        runId: 'run-1',
        executionProviderId: 'anthropic:claude-agent-sdk' as any,
        workerId: 'main_agent',
        leaseOwner: '__scheduler__:main_agent:job-1',
        scheduledFor: '2026-06-10T00:00:00.000Z',
        startedAt: '2026-06-10T00:00:00.000Z',
        leaseExpiresAt: '2026-06-10T00:05:00.000Z',
        requireNextRun: false,
        getCoordinationRepository: () =>
          ({
            appendRunnerControlEvent: vi.fn(async () => 'persisted'),
          }) as any,
        warn: vi.fn(),
      });

      await expect(claim).resolves.toEqual(expect.objectContaining({ lease }));
    } finally {
      stopWorkerHeartbeat();
    }
  });
});
