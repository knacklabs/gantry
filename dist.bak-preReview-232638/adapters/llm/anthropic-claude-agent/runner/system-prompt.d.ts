import type { AgentPersona } from '../../../../shared/agent-persona.js';
import type { AgentRunnerInput } from './types.js';
export declare function buildSystemPrompt(input?: {
    assistantName?: string;
    persona?: AgentPersona;
    compiledSystemPrompt?: string;
}): string[];
export declare function readMemoryContextBlock(agentInput: AgentRunnerInput): string;
export declare function buildRunnerSystemPrompt(agentInput: AgentRunnerInput, memoryBlock: string): ReturnType<typeof buildSystemPrompt>;
