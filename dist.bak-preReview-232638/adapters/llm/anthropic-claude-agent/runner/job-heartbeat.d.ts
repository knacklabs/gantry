import type { AgentRunnerInput } from './types.js';
import type { writeOutput } from './output.js';
type RunnerWriteOutput = typeof writeOutput;
export declare function startJobHeartbeat(input: {
    agentInput: AgentRunnerInput;
    writeOutput: RunnerWriteOutput;
    getSessionId: () => string | undefined;
}): {
    markActivity(): void;
    recordToolActivity(toolName: string): void;
    stop(): void;
};
export {};
