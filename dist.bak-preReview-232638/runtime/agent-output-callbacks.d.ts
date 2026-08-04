import type { AgentOutput } from './agent-spawn-types.js';
export declare function isVisibleResultFrame(output: AgentOutput): boolean;
export declare function isRunnerCompletionEvidenceFrame(output: AgentOutput): boolean;
export declare function isAgentTurnCompleteMarker(result: AgentOutput): boolean;
export declare function createSerializedAgentOutputCallbacks(args: {
    handle: (result: AgentOutput) => Promise<void>;
    onError: (err: unknown) => void;
}): {
    enqueue: (result: AgentOutput) => Promise<void>;
    wait: () => Promise<void>;
};
