import type { AgentOutput, RunnerProcessSpec } from './agent-spawn-types.js';
export declare function sandboxBlockedEvents(input: {
    spec: RunnerProcessSpec;
    message: string;
    sanitize: (value: string, maxChars?: number) => string;
}): NonNullable<AgentOutput['runtimeEvents']>;
