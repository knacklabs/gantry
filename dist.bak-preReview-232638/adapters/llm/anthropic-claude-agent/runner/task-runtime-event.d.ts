import type { AgentRunnerInput, AgentRunnerRuntimeEventOutput } from './types.js';
export declare function taskRuntimeEvent(agentInput: AgentRunnerInput, message: Record<string, unknown>): AgentRunnerRuntimeEventOutput | null;
