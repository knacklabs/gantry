import type { WorkerCoordinationRepository } from '../../domain/ports/worker-coordination.js';
import { WORKER_STALE_AFTER_MS } from '../../shared/worker-heartbeat.js';
import { nowMs as currentTimeMs, toIso } from '../../shared/time/datetime.js';

export async function recoverExpiredWorkerLeases(input: {
  coordination: WorkerCoordinationRepository;
  logger: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}): Promise<void> {
  const { coordination, logger } = input;
  try {
    const staleBefore = toIso(currentTimeMs() - WORKER_STALE_AFTER_MS);
    const unhealthy = await coordination.markStaleWorkersUnhealthy({
      staleBefore,
    });
    if (unhealthy.length > 0) {
      logger.warn(
        { workerInstanceIds: unhealthy },
        'Marked heartbeat-lapsed worker instances unhealthy',
      );
    }
    const recovered = await coordination.recoverExpiredRunLeases({
      staleBefore,
    });
    if (recovered.length > 0) {
      logger.warn(
        {
          count: recovered.length,
          leases: recovered.map((lease) => ({
            runId: lease.runId,
            jobId: lease.jobId,
            workerInstanceId: lease.workerInstanceId,
            fencingVersion: lease.fencingVersion,
          })),
        },
        'Expired lapsed run leases; runs are retryable with a higher fencing version',
      );
    }
    const releasedSlots =
      (await coordination.releaseRunSlotsForStaleWorkers?.({
        staleBefore,
      })) ?? 0;
    if (releasedSlots > 0) {
      logger.warn(
        { count: releasedSlots, staleBefore },
        'Released run slots held by lapsed worker instances',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to recover expired worker run leases');
  }
}
