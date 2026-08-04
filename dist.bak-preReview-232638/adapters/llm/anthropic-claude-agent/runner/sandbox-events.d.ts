import type { AgentRunnerInput, AgentRunnerOutput } from './types.js';
export declare function sandboxBlockedRuntimeEvents(agentInput: AgentRunnerInput, payload: Record<string, unknown>): NonNullable<AgentRunnerOutput['runtimeEvents']>;
export declare function sdkSandboxBlockedRuntimeEvents(agentInput: AgentRunnerInput, errorMessage: string): NonNullable<AgentRunnerOutput['runtimeEvents']>;
export declare function isSandboxBlockedError(errorMessage: string): boolean;
