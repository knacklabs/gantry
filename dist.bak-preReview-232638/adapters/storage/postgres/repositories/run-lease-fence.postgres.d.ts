import { type SQL } from 'drizzle-orm';
export interface RunLeaseFence {
    leaseToken: string;
    workerInstanceId: string;
    fencingVersion: number;
}
export declare function activeRunLeaseTokenFence(input: {
    runId: string | SQL;
    leaseToken: string | SQL;
    fencingVersion: number | SQL;
    now: string | SQL;
    workerInstanceId?: string | SQL;
}): SQL;
export declare function activeRunLeaseFence(input: {
    runId: string | SQL;
    fence: RunLeaseFence;
    now: string | SQL;
}): SQL;
export declare function settledRunLeaseFence(input: {
    runId: string | SQL;
    fence: RunLeaseFence;
    now: string | SQL;
}): SQL;
