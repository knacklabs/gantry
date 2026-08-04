import type { ContinuationHandler } from './group-queue-types.js';
import type { ContinuationRunnerControlPort } from './group-queue-types.js';
import type { LiveTurnLocalRunnerHooks } from './live-turn-authority.js';
interface LiveTurnHookState {
    active: boolean;
    idleWaiting: boolean;
    isTaskRun: boolean;
    workspaceFolder: string | null;
    threadId: string | null;
    continuationHandler: ContinuationHandler | null;
}
export declare function createLiveTurnLocalRunnerHooks(input: {
    groupJid: string;
    state: LiveTurnHookState;
    runnerControlPort: ContinuationRunnerControlPort;
    closeStdin: () => void;
    stopGroup: () => void;
}): LiveTurnLocalRunnerHooks;
export {};
