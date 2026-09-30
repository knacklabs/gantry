import { normalizeThreadQueueId } from '../shared/thread-queue-key.js';
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

export function createLiveTurnLocalRunnerHooks(input: {
  groupJid: string;
  state: LiveTurnHookState;
  runnerControlPort: ContinuationRunnerControlPort;
  closeStdin: () => void;
  stopGroup: () => void;
  requeueInput: () => void;
}): LiveTurnLocalRunnerHooks {
  return {
    applyContinuation: ({ text, sequence, threadId }) => {
      const { state } = input;
      if (!state.active || !state.workspaceFolder || state.isTaskRun)
        return false;
      const incomingThreadId = normalizeThreadQueueId(threadId) || null;
      if (state.threadId !== incomingThreadId) return false;
      state.idleWaiting = false;
      input.runnerControlPort.writeContinuationInput({
        workspaceFolder: state.workspaceFolder,
        text,
        sequence,
        threadId: incomingThreadId,
      });
      state.continuationHandler?.();
      return true;
    },
    applyCloseStdin: input.closeStdin,
    applyStop: input.stopGroup,
    requeueInput: input.requeueInput,
  };
}
