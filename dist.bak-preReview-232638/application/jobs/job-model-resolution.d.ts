import type { Job } from '../../domain/types.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import { type ModelCatalogEntry, type ModelResolution } from '../../shared/model-catalog.js';
import { type AgentEngine, type AgentHarness } from '../../shared/agent-engine.js';
import type { ExecutionRouteResolution } from '../../shared/model-execution-route.js';
export type JobModelDefaultConfig = {
    model?: string;
    source: string;
};
export interface ResolvedJobModel {
    selectedModel?: string;
    source: string;
    resolution?: ModelResolution;
    entry?: ModelCatalogEntry;
    agentHarness?: AgentHarness;
    routeResolution?: ExecutionRouteResolution;
    agentEngine: AgentEngine;
    defaultExecutionProviderId?: ExecutionProviderId;
}
export declare function modelUseKindForJobSchedule(scheduleType: Job['schedule_type']): 'oneTimeJob' | 'recurringJob';
export declare function jobModelWorkloadForSchedule(scheduleType: Job['schedule_type']): 'one_time_job' | 'recurring_job';
export declare function resolveDefaultJobExecutionProviderId(scheduleType: Job['schedule_type'], agentHarness?: AgentHarness): ExecutionProviderId | undefined;
export declare function resolveJobModel(job: Pick<Job, 'model' | 'schedule_type'>, defaultConfig: JobModelDefaultConfig, agentHarness?: AgentHarness): ResolvedJobModel;
