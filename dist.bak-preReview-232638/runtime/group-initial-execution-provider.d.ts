import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { ConversationRoute } from '../domain/types.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import { type ModelStatusSelectionUpdate } from '../session/session-model-status.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
export declare function resolveInitialGroupExecutionProviderId(input: {
    group: Pick<ConversationRoute, 'agentConfig' | 'folder'>;
    appId: string;
    defaultModel?: string;
    executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
    agentHarness: AgentHarness;
    listConfiguredProviders?: GroupProcessingDeps['getConfiguredModelProviders'];
    familyOrder?: ReturnType<NonNullable<GroupProcessingDeps['getModelFamilyOrder']>>;
}): Promise<{
    executionProviderId: ExecutionProviderId;
    firstModel?: string;
    failoverCandidates: string[];
    initialModelSelection: ModelStatusSelectionUpdate;
}>;
export declare function resolveGroupRouteExecutionProviderId(input: {
    group: Pick<ConversationRoute, 'agentConfig' | 'folder'>;
    appId: string;
    defaultModel?: string;
    executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
    agentHarness: AgentHarness;
    listConfiguredProviders?: GroupProcessingDeps['getConfiguredModelProviders'];
    familyOrder?: ReturnType<NonNullable<GroupProcessingDeps['getModelFamilyOrder']>>;
}): Promise<ExecutionProviderId>;
export declare function resolveGroupRouteExecutionProviderIdForDeps(input: {
    group: Pick<ConversationRoute, 'agentConfig' | 'folder'>;
    appId: string;
    defaultModel?: string;
    deps: Pick<GroupProcessingDeps, 'executionAdapter' | 'getConfiguredModelProviders' | 'getModelFamilyOrder' | 'getSelectedAgentHarness'>;
}): Promise<ExecutionProviderId>;
