import { writeCloseSignal, writeContinuationInput, } from './continuation-input.js';
export const RUNNER_CONTROL_PORT = Symbol.for('gantry.runnerControlPort');
export const localContinuationRunnerControlPort = {
    writeContinuationInput: ({ workspaceFolder, text, sequence, threadId }) => writeContinuationInput(workspaceFolder, text, sequence, threadId),
    writeCloseSignal: ({ workspaceFolder, threadId }) => writeCloseSignal(workspaceFolder, threadId),
};
export function isGroupStateIdle(state) {
    return (!state.active &&
        !state.pendingMessages &&
        state.pendingTasks.length === 0 &&
        !state.runningTaskId &&
        !state.process &&
        !state.idleWaiting);
}
