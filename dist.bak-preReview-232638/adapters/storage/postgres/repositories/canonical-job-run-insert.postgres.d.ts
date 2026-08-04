import type { JobRun } from '../../../../domain/repositories/domain-types.js';
import { type CanonicalDb } from './canonical-graph-repository.postgres.js';
type CanonicalExecutor = CanonicalDb | Parameters<Parameters<CanonicalDb['transaction']>[0]>[0];
export declare function insertCanonicalJobRun(input: {
    run: JobRun;
    executor: CanonicalExecutor;
    graph: {
        agentId: string;
        configVersionId: string;
    };
    nextRunShortId: (jobId: string) => Promise<number>;
}): Promise<boolean>;
export {};
