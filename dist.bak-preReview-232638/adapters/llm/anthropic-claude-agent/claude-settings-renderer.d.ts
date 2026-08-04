import type { AgentConfigVersion, LlmProfile } from '../../../domain/agent/agent.js';
export interface ClaudeSettingsRenderInput {
    cliEntryPoint: string;
    model?: string;
    agentConfigVersion?: AgentConfigVersion;
    llmProfile?: LlmProfile;
    permissionPolicyRefs?: string[];
    memoryPolicyRef?: string;
    providerOptions?: Record<string, unknown>;
}
export interface ClaudeSettings {
    env: Record<string, string>;
    availableModels: readonly string[];
    model: string;
    autoMemoryEnabled: boolean;
    hooks: Record<string, unknown[]>;
}
export declare function renderClaudeSettings(input: ClaudeSettingsRenderInput): ClaudeSettings;
export declare function stringifyClaudeSettings(settings: ClaudeSettings): string;
