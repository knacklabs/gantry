import type { AgentRunnerInput } from './types.js';
import type { YoloModeMatch } from '../../../../shared/yolo-mode-policy.js';
export declare function yoloDenylistPromptReason(match: YoloModeMatch): string;
export declare function emitYoloDenylistHit(input: {
    agentInput: AgentRunnerInput;
    getNewSessionId: () => string | undefined;
    match: YoloModeMatch;
    principal: string;
    reason: string;
}): void;
export declare function emitJobToolActivity(agentInput: AgentRunnerInput, getNewSessionId: () => string | undefined, phase: string, toolName: string, payload?: Record<string, unknown>): void;
