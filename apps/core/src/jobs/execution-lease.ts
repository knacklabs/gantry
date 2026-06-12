import { randomUUID } from 'crypto';

import type {
  RunLease,
  RunLeaseRepository,
  RunnerControlEventRepository,
  RunnerControlEventType,
} from '../domain/ports/worker-coordination.js';
import type { Job } from '../domain/types.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { notifySchedulerRunRecovered } from './execution-notifications.js';
import { requireWorkerInstanceId } from './worker-identity.js';
import type { SchedulerDependencies } from './types.js';

type WarnLog = (context: Record<string, unknown>, message: string) => void;

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
    try {
      await input.getCoordinationRepository().appendRunnerControlEvent({
        id: randomUUID(),
        runId: input.runId,
        jobId: input.currentJob.id,
        leaseToken: lease.leaseToken,
        eventType,
        payload,
        nonce: randomUUID(),
      });
    } catch (err) {
      input.warn(
        { err, jobId: input.currentJob.id, runId: input.runId, eventType },
        'Failed to append runner control event',
      );
    }
  };
  await recordRunnerControlEvent('claimed', {
    workerInstanceId: lease.workerInstanceId,
    fencingVersion: lease.fencingVersion,
    scheduledFor: input.scheduledFor,
  });
  if (lease.recoveredFromExpiredLease) {
    await notifySchedulerRunRecovered({
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

export function startSchedulerRunLeaseHeartbeat(input: {
  runId: string;
  leaseContext: SchedulerRunLeaseContext;
  ttlMs: number;
  getCoordinationRepository: () => Pick<
    RunLeaseRepository,
    'heartbeatRunLease'
  >;
  warn: WarnLog;
}): SchedulerRunLeaseHeartbeat {
  const intervalMs = Math.max(
    1_000,
    Math.min(30_000, Math.floor(input.ttlMs / 3)),
  );
  let stopped = false;
  const heartbeat = async (): Promise<void> => {
    if (stopped) return;
    try {
      const renewed = await input
        .getCoordinationRepository()
        .heartbeatRunLease({
          runId: input.runId,
          leaseToken: input.leaseContext.lease.leaseToken,
          ttlMs: input.ttlMs,
        });
      if (!renewed) {
        input.warn(
          {
            runId: input.runId,
            fencingVersion: input.leaseContext.lease.fencingVersion,
          },
          'Run lease heartbeat was fenced or expired',
        );
      }
    } catch (err) {
      input.warn(
        { err, runId: input.runId },
        'Failed to heartbeat scheduler run lease',
      );
    }
  };
  const timer = setInterval(() => {
    void heartbeat();
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
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
