import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import type { DeepAgentRunnerInput } from './types.js';
export interface DeepAgentJobHeartbeat {
    /** Reset the idle timer (e.g. on each streamed model delta). */
    markActivity(): void;
    /** Record a tool invocation by name; bumps the tool-call counters. */
    recordToolActivity(toolName: string): void;
    /** Stop the periodic emitter. Idempotent. */
    stop(): void;
}
export declare function startDeepAgentJobHeartbeat(input: {
    agentInput: DeepAgentRunnerInput;
    writeFrame: (frame: RunnerOutputFrame) => void;
    getSessionId: () => string | undefined;
}): DeepAgentJobHeartbeat;
