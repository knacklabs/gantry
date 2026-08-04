import { normalizeThreadQueueId } from '../shared/thread-queue-key.js';
export function createLiveTurnLocalRunnerHooks(input) {
    return {
        applyContinuation: ({ text, sequence, threadId }) => {
            const { state } = input;
            if (!state.active || !state.workspaceFolder || state.isTaskRun)
                return;
            const incomingThreadId = normalizeThreadQueueId(threadId) || null;
            if (state.threadId !== incomingThreadId)
                return;
            state.idleWaiting = false;
            input.runnerControlPort.writeContinuationInput({
                workspaceFolder: state.workspaceFolder,
                text,
                sequence,
                threadId: incomingThreadId,
            });
            state.continuationHandler?.();
        },
        applyCloseStdin: input.closeStdin,
        applyStop: input.stopGroup,
    };
}
