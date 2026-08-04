import type { Job, JobRecoveryIntent, JobRecoveryIntentState, JobSetupState } from '../../domain/types.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
export type JobRecoveryIntentSource = 'preflight_setup' | 'final_setup' | 'permission_denied' | 'permission_timeout' | 'transient_permission';
export interface JobRecoveryIntentUpsertResult {
    intent: JobRecoveryIntent;
    created: boolean;
}
export declare function buildJobRecoveryIntent(input: {
    job: Pick<Job, 'id' | 'recovery_intent'>;
    setupState: JobSetupState;
    source: JobRecoveryIntentSource;
    runId?: string | null;
    now?: string;
}): JobRecoveryIntent;
export declare function createJobRecoveryIntent(input: {
    job: Job;
    setupState: JobSetupState;
    source: JobRecoveryIntentSource;
    runId?: string | null;
    opsRepository: Pick<RuntimeJobRepository, 'updateJob'>;
    now?: string;
}): Promise<JobRecoveryIntentUpsertResult>;
export declare function transitionJobRecoveryIntent(input: {
    job: Job;
    dedupeKey: string;
    state: JobRecoveryIntentState;
    opsRepository: Pick<RuntimeJobRepository, 'updateJob'>;
    now?: string;
    error?: string | null;
}): Promise<JobRecoveryIntent | null>;
