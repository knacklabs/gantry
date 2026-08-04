import { type ModelWorkload } from '../../shared/model-catalog.js';
import type { AgentHarness } from '../../shared/agent-engine.js';
export type JobModelWorkload = Extract<ModelWorkload, 'one_time_job' | 'recurring_job'>;
export declare function resolveOptionalJobModel(value: unknown, workload?: JobModelWorkload): string | undefined;
export declare function resolveRequestedJobModel(modelAlias: unknown, workload?: JobModelWorkload): string | undefined;
export declare function assertJobModelHarnessCompatible(input: {
    modelAlias?: string | null;
    workload: JobModelWorkload;
    agentHarness?: AgentHarness;
}): void;
export declare function resolveRequestedJobModelPatch(modelAlias: unknown): {
    specified: boolean;
    model?: string | null;
};
