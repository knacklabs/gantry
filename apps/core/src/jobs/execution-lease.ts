import { randomUUID } from 'crypto';

import type {
  RunLease,
  RunLeaseRepository,
  RunnerControlEventRepository,
  RunnerControlEventType,
} from '../domain/ports/worker-coordination.js';
import type { Job } from '../domain/types.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { nowIso, nowMs, toIso } from '../shared/time/datetime.js';
import { retryBackoffMs } from './execution-finalization.js';
import { notifySchedulerRunRecovered } from './execution-notifications.js';
import { requireWorkerInstanceId } from './worker-identity.js';
import type { SchedulerDependencies } from './types.js';

type WarnLog = (context: Record<string, unknown>, message: string) => void;
export const RUNNER_CONTROL_EVENT_WRITE_TIMEOUT_MS = 5_000;

export type RecordRunnerControlEvent = (
  eventType: RunnerControlEventType,
  payload: Record<string, unknown>,
) => Promise<void>;

export interface SchedulerRunLeaseContext {
  lease: RunLease;
  recordRunnerControlEvent: RecordRunnerControlEvent;
}

export interface SchedulerRunLeaseHeartbeat {
  stop(): void;
}

export const SCHEDULER_RUN_LEASE_LOST_ERROR =
  'Scheduler run stopped because its lease was lost.';

export function createSchedulerRunLeaseAbort(): {
  signal: AbortSignal;
  error: string;
  abort: () => void;
  isAborted: () => boolean;
  errorFor: (err: unknown) => string;
} {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    error: SCHEDULER_RUN_LEASE_LOST_ERROR,
    abort: () => controller.abort(new Error(SCHEDULER_RUN_LEASE_LOST_ERROR)),
    isAborted: () => controller.signal.aborted,
    errorFor: (err) =>
      controller.signal.aborted
        ? SCHEDULER_RUN_LEASE_LOST_ERROR
        : err instanceof Error
          ? err.message
          : String(err),
  };
}

function bindSchedulerRunExternalAbort(
  signal: AbortSignal | undefined,
  abort: () => void,
): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function runnerControlEventTimeout(
  eventType: RunnerControlEventType,
): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Timed out appending runner control event: ${eventType}`),
        ),
      RUNNER_CONTROL_EVENT_WRITE_TIMEOUT_MS,
    );
    timer.unref?.();
  });
}

/**
 * Worker claim step: the run executes only with a confirmed lease. Persists
 * the 'claimed' runner-control event and, when a previous active lease was
 * expired/recovered, sends the run-recovered notification.
 */
export async function claimSchedulerRunLease(input: {
  deps: SchedulerDependencies;
  currentJob: Job;
  runId: string;
  executionProviderId: ExecutionProviderId;
  workerId: string;
  leaseOwner: string;
  scheduledFor: string;
  startedAt: string;
  leaseExpiresAt: string;
  requireNextRun: boolean;
  getCoordinationRepository: () => RunnerControlEventRepository;
  warn: WarnLog;
}): Promise<SchedulerRunLeaseContext | null> {
  const lease = await input.deps.opsRepository.claimDueJobRunStart({
    jobId: input.currentJob.id,
    runId: input.runId,
    executionProviderId: input.executionProviderId,
    workerId: input.workerId,
    leaseOwner: input.leaseOwner,
    workerInstanceId: requireWorkerInstanceId(),
    scheduledFor: input.scheduledFor,
    startedAt: input.startedAt,
    retryCount: input.currentJob.consecutive_failures,
    leaseExpiresAt: input.leaseExpiresAt,
    requireNextRun: input.requireNextRun,
  });
  if (!lease) return null;
  // Persist-before-expose run lifecycle evidence: worker events land in the
  // append-only runner_control_events outbox keyed to this lease.
  const recordRunnerControlEvent: RecordRunnerControlEvent = async (
    eventType,
    payload,
  ) => {
    const write = input.getCoordinationRepository().appendRunnerControlEvent({
      id: randomUUID(),
      runId: input.runId,
      jobId: input.currentJob.id,
      leaseToken: lease.leaseToken,
      eventType,
      payload,
      nonce: randomUUID(),
    });
    write.catch(() => undefined);
    let result: Awaited<
      ReturnType<RunnerControlEventRepository['appendRunnerControlEvent']>
    >;
    try {
      result = await Promise.race([
        write,
        runnerControlEventTimeout(eventType),
      ]);
    } catch (err) {
      input.warn(
        { err, jobId: input.currentJob.id, runId: input.runId, eventType },
        'Failed to append runner control event',
      );
      if (eventType === 'claimed') throw err;
      return;
    }
    if (result !== 'persisted') {
      const err = new Error(
        `Runner control event was not persisted: ${result}`,
      );
      input.warn(
        { err, jobId: input.currentJob.id, runId: input.runId, eventType },
        'Failed to append runner control event',
      );
      if (eventType === 'claimed') throw err;
    }
  };
  try {
    await recordRunnerControlEvent('claimed', {
      workerInstanceId: lease.workerInstanceId,
      fencingVersion: lease.fencingVersion,
      scheduledFor: input.scheduledFor,
    });
  } catch (err) {
    await failClaimedRunAfterControlEvidenceFailure({ ...input, lease });
    throw err;
  }
  if (lease.recoveredFromExpiredLease) {
    void notifySchedulerRunRecovered({
      job: input.currentJob,
      runId: input.runId,
      sendMessage: input.deps.sendMessage,
    }).catch((err) =>
      input.warn(
        { err, jobId: input.currentJob.id, runId: input.runId },
        'Failed to send run recovered notification',
      ),
    );
  }
  return { lease, recordRunnerControlEvent };
}

async function failClaimedRunAfterControlEvidenceFailure(input: {
  deps: SchedulerDependencies;
  currentJob: Job;
  runId: string;
  lease: RunLease;
  warn: WarnLog;
}): Promise<void> {
  const retryCount = input.currentJob.consecutive_failures + 1;
  const exceededRetry = retryCount > input.currentJob.max_retries;
  const exceededConsecutive =
    retryCount >= input.currentJob.max_consecutive_failures;
  const deadLettered = exceededRetry || exceededConsecutive;
  const shouldRetry =
    !deadLettered && input.currentJob.schedule_type !== 'manual';
  const jobUpdates: Partial<Job> = {
    status: deadLettered ? 'dead_lettered' : 'active',
    next_run: shouldRetry
      ? toIso(nowMs() + retryBackoffMs(input.currentJob, retryCount))
      : null,
    last_run: nowIso(),
    lease_run_id: null,
    lease_expires_at: null,
    consecutive_failures: retryCount,
    pause_reason: deadLettered
      ? `Paused after ${retryCount} failures. Fix the blocker, then resume the job.`
      : null,
  };
  const errorSummary =
    'Scheduler run failed before runner-control evidence was persisted.';
  try {
    if (input.deps.opsRepository.finalizeJobRunWithLease) {
      const finalized =
        await input.deps.opsRepository.finalizeJobRunWithLease.call(
          input.deps.opsRepository,
          {
            jobId: input.currentJob.id,
            runId: input.runId,
            leaseToken: input.lease.leaseToken,
            workerInstanceId: input.lease.workerInstanceId,
            fencingVersion: input.lease.fencingVersion,
            leaseOutcome: 'failed',
            runStatus: 'failed',
            resultSummary: null,
            errorSummary,
            jobUpdates,
          },
        );
      if (!finalized) {
        input.warn(
          { jobId: input.currentJob.id, runId: input.runId },
          'Failed to finalize scheduler job after runner-control evidence failure',
        );
      }
      return;
    }
    if (input.deps.opsRepository.finalizeJobRunLease) {
      const finalized = await input.deps.opsRepository.finalizeJobRunLease.call(
        input.deps.opsRepository,
        {
          runId: input.runId,
          leaseToken: input.lease.leaseToken,
          workerInstanceId: input.lease.workerInstanceId,
          fencingVersion: input.lease.fencingVersion,
          leaseOutcome: 'failed',
          runStatus: 'failed',
          resultSummary: null,
          errorSummary,
        },
      );
      if (!finalized) {
        input.warn(
          { jobId: input.currentJob.id, runId: input.runId },
          'Failed to finalize scheduler run after runner-control evidence failure',
        );
      }
      await input.deps.opsRepository.updateJob(input.currentJob.id, jobUpdates);
      return;
    }
    if (input.deps.opsRepository.settleJobRunLease) {
      const settled = await input.deps.opsRepository.settleJobRunLease({
        runId: input.runId,
        leaseToken: input.lease.leaseToken,
        workerInstanceId: input.lease.workerInstanceId,
        fencingVersion: input.lease.fencingVersion,
        outcome: 'failed',
      });
      if (!settled) {
        input.warn(
          { jobId: input.currentJob.id, runId: input.runId },
          'Failed to settle scheduler run after runner-control evidence failure',
        );
      }
      await input.deps.opsRepository.updateJob(input.currentJob.id, jobUpdates);
    }
  } catch (err) {
    input.warn(
      { err, jobId: input.currentJob.id, runId: input.runId },
      'Failed to fail scheduler run after runner-control evidence failure',
    );
  }
}

export function startSchedulerRunLeaseHeartbeat(input: {
  runId: string;
  leaseContext: SchedulerRunLeaseContext;
  ttlMs: number;
  deadlineMs?: number;
  getCoordinationRepository: () => Pick<
    RunLeaseRepository,
    'heartbeatRunLease'
  >;
  warn: WarnLog;
  onLeaseLost?: () => void;
  externalAbortSignal?: AbortSignal;
}): SchedulerRunLeaseHeartbeat {
  const intervalMs = Math.max(
    1_000,
    Math.min(30_000, Math.floor(input.ttlMs / 3)),
  );
  let stopped = false;
  const heartbeat = async (): Promise<void> => {
    if (stopped) return;
    const leaseTtlMs = input.deadlineMs
      ? Math.min(input.ttlMs, input.deadlineMs + 30_000 - nowMs())
      : input.ttlMs;
    if (leaseTtlMs <= 0) {
      stopped = true;
      clearInterval(timer);
      unbindExternalAbort();
      input.warn(
        {
          runId: input.runId,
          fencingVersion: input.leaseContext.lease.fencingVersion,
        },
        'Run lease heartbeat stopped at scheduler deadline',
      );
      input.onLeaseLost?.();
      return;
    }
    try {
      const renewed = await input
        .getCoordinationRepository()
        .heartbeatRunLease({
          runId: input.runId,
          leaseToken: input.leaseContext.lease.leaseToken,
          ttlMs: Math.max(1_000, leaseTtlMs),
        });
      if (!renewed) {
        stopped = true;
        clearInterval(timer);
        input.warn(
          {
            runId: input.runId,
            fencingVersion: input.leaseContext.lease.fencingVersion,
          },
          'Run lease heartbeat was fenced or expired',
        );
        unbindExternalAbort();
        input.onLeaseLost?.();
      }
    } catch (err) {
      input.warn(
        { err, runId: input.runId },
        'Failed to heartbeat scheduler run lease',
      );
    }
  };
  const unbindExternalAbort = input.onLeaseLost
    ? bindSchedulerRunExternalAbort(
        input.externalAbortSignal,
        input.onLeaseLost,
      )
    : () => undefined;
  const timer = setInterval(() => {
    void heartbeat();
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      unbindExternalAbort();
      clearInterval(timer);
    },
  };
}

/**
 * Lease-fenced settlement: terminal writes require this worker's lease
 * coordinates to still be the run's active lease. Returns false when the run
 * was recovered by another worker — the caller must drop all terminal writes.
 */
export async function settleSchedulerRunLease(input: {
  deps: SchedulerDependencies;
  currentJob: Job;
  runId: string;
  leaseContext: SchedulerRunLeaseContext;
  error: string | null;
  warn: WarnLog;
}): Promise<boolean> {
  const settled = await input.deps.opsRepository.settleJobRunLease({
    runId: input.runId,
    leaseToken: input.leaseContext.lease.leaseToken,
    workerInstanceId: input.leaseContext.lease.workerInstanceId,
    fencingVersion: input.leaseContext.lease.fencingVersion,
    outcome: input.error ? 'failed' : 'completed',
  });
  if (!settled) {
    input.warn(
      {
        jobId: input.currentJob.id,
        runId: input.runId,
        fencingVersion: input.leaseContext.lease.fencingVersion,
      },
      'Stale worker lost its run lease; dropping terminal writes for recovered run',
    );
    return false;
  }
  await input.leaseContext.recordRunnerControlEvent('terminal_state', {
    outcome: input.error ? 'failed' : 'completed',
    fencingVersion: input.leaseContext.lease.fencingVersion,
  });
  return true;
}
