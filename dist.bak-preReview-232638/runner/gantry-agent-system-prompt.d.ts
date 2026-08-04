import { type AgentPersona } from '../shared/agent-persona.js';
export type GantryAgentPromptMode = 'full' | 'minimal' | 'none';
export type GantryAgentRuntimeProjection = 'native-tool-projection' | 'wrapped-tool-projection';
export interface GantryAgentSystemPromptInput {
    promptMode?: GantryAgentPromptMode;
    runtimeProjection: GantryAgentRuntimeProjection;
    assistantName?: string;
    persona?: AgentPersona;
    compiledSystemPrompt?: string;
    hasMemoryContext?: boolean;
    selectedToolRules?: readonly string[];
    workspaceFolder?: string;
    conversationId?: string;
    threadId?: string;
    isScheduledJob?: boolean;
    currentDateTimeIso?: string;
    timezone?: string;
    sandboxSummary?: string;
}
export interface GantryAgentSystemPrompt {
    mode: GantryAgentPromptMode;
    staticPrompt: string;
    dynamicPrompt: string;
    prompt: string;
}
export declare function resolveGantryAgentPromptMode(value: GantryAgentPromptMode | undefined): GantryAgentPromptMode;
export declare function buildGantryAgentSystemPrompt(input: GantryAgentSystemPromptInput): GantryAgentSystemPrompt;
