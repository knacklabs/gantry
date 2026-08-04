import type { ConversationRoute } from '../domain/types.js';
import { type LlmProfileResolution } from '../application/model-resolution/llm-profile-resolution-service.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import type { FamilyOrderOverrides } from '../shared/model-families.js';
import { type ConfiguredModelProvidersLookup } from './model-family-resolution.js';
import type { AgentInput } from './agent-spawn-types.js';
export type SpawnModelWorkload = 'chat' | 'one_time_job' | 'recurring_job';
export declare function resolveSpawnModel(input: {
    group: ConversationRoute;
    agentInput: AgentInput;
    appId: string;
    modelConfig: {
        model?: string;
        source: string;
    };
    agentHarness: AgentHarness;
    modelFamilyOrder?: FamilyOrderOverrides;
    listConfiguredProviders: ConfiguredModelProvidersLookup;
}): Promise<{
    modelWorkload: SpawnModelWorkload;
    resolvedModel: LlmProfileResolution;
}>;
