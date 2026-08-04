import { type PromptAccessPreset, type PromptModelIdentity, type PromptProfileServiceOptions } from '../application/agents/prompt-profile-service.js';
import type { ConversationRoute } from '../domain/types.js';
import type { AgentInput } from './agent-spawn-types.js';
export declare function resolveSpawnPromptAccessPreset(configured: PromptAccessPreset, hideAuthorityTools: boolean): PromptAccessPreset;
export declare function compileSpawnSystemPrompt(input: {
    group: ConversationRoute;
    agentInput: AgentInput;
    appId: string;
    accessPreset: PromptAccessPreset;
    mcpInventoryToolsMounted: boolean;
    modelIdentity?: PromptModelIdentity;
    fileArtifactStore: PromptProfileServiceOptions['fileArtifactStore'];
    measureAsync: <T>(name: 'promptCompileMs', fn: () => Promise<T>) => Promise<T>;
}): Promise<string>;
