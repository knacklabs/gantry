import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { NormalizedModelUsage } from '../shared/model-catalog.js';
import { modelUseKindForJobSchedule, resolveDefaultJobExecutionProviderId, resolveJobModel, type ResolvedJobModel } from '../application/jobs/job-model-resolution.js';
export type { NormalizedModelUsage };
export { modelUseKindForJobSchedule, resolveDefaultJobExecutionProviderId, resolveJobModel, };
export declare function resolveJobExecutionProviderId(input: {
    resolvedModel: ResolvedJobModel;
    executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
    executionAdapters?: Pick<AgentExecutionAdapterRegistry, 'list'>;
    fallbackForInjectedRunner?: boolean;
}): ExecutionProviderId;
export declare function jobStartedModelPayload(resolved: ResolvedJobModel): {
    context_window_tokens: number | null;
    agent_engine: "deepagents" | "anthropic_sdk";
    agent_harness: "auto" | "deepagents" | "anthropic_sdk" | undefined;
    response_family: string | null;
    execution_provider_id: string | null;
    supported_credential_modes: string[];
    resolved_model_alias: string | null;
    resolved_model_profile_id: string | null;
    model_source: string;
    model_selection_reason: string | null;
    cache_policy: string;
};
export declare function jobCompletedModelPayload(resolved: ResolvedJobModel, usage?: NormalizedModelUsage): {
    resolved_model_alias: string | null;
    resolved_model_profile_id: string | null;
    model_source: string;
    model_selection_reason: string | null;
    cache_policy: string;
    usage: NormalizedModelUsage | undefined;
};
