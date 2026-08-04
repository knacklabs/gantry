import type { JobTriggerRecord } from '../schema/control-plane-records.postgres.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresJobTriggerRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    create(input: {
        jobId: string;
        requestedBy?: string;
    }): Promise<JobTriggerRecord>;
    bindPendingToRun(jobId: string, runId: string): Promise<JobTriggerRecord | undefined>;
    bindToRun(triggerId: string, runId: string): Promise<JobTriggerRecord | undefined>;
    markCompleted(triggerId: string, status: 'completed' | 'failed'): Promise<void>;
    getById(triggerId: string): Promise<JobTriggerRecord | undefined>;
}
