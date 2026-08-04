import type { JobRun } from '../../../../domain/repositories/domain-types.js';
import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import { type CanonicalDb, type CanonicalExecutor } from './canonical-graph-repository.postgres.js';
/**
 * Transactionally claim a due job run for a worker: insert the run, issue the
 * worker's run lease (token + fencing version), and flip the job to running.
 * Returns null when the job is not claimable or another worker won the claim.
 */
export declare function claimDueCanonicalJobRunStart(input: {
    db: CanonicalDb;
    jobId: string;
    run: JobRun;
    leaseExpiresAt: string;
    workerInstanceId: string;
    requireNextRun?: boolean;
    insertRun: (run: JobRun, tx: CanonicalExecutor) => Promise<boolean>;
}): Promise<RunLease | null>;
