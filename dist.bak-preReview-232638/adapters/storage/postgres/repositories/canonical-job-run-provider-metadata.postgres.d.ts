import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare function updateCanonicalJobRunProviderMetadata(db: CanonicalDb, runId: string | readonly string[], input: {
    fenceRunId?: string;
    leaseToken?: string;
    workerInstanceId?: string;
    fencingVersion?: number;
    providerRunId?: string | null;
    providerSessionId?: string | null;
}): Promise<boolean>;
