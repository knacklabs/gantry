import {
  writeCloseSignal,
  writeContinuationInput,
} from './continuation-input.js';
import type { GroupQueuePolicyOptions } from './group-queue-policy.js';
import type { RunnerControlPort } from './runner-control-port.js';

export type QueueKind = 'message' | 'task';
export type RuntimeAdmissionClass =
  | 'interactive'
  | 'interactive_child'
  | 'background'
  | 'maintenance';
export type TaskAdmissionClass = Exclude<RuntimeAdmissionClass, 'interactive'>;

export type ContinuationOptions = {
  threadId?: string | null;
  senderUserIds?: readonly string[] | null;
};

export type ContinuationHandler = () => void;

export type ContinuationRunnerControlPort = Pick<
  RunnerControlPort,
  'writeContinuationInput' | 'writeCloseSignal'
>;

export const localContinuationRunnerControlPort: ContinuationRunnerControlPort =
  {
    writeContinuationInput: ({ workspaceFolder, text, sequence, threadId }) =>
      writeContinuationInput(workspaceFolder, text, sequence, threadId),
    writeCloseSignal: ({ workspaceFolder, threadId }) =>
      writeCloseSignal(workspaceFolder, threadId),
  };

export interface QueuedTask {
  id: string;
  kind: QueueKind;
  admissionClass: TaskAdmissionClass;
  groupJid: string;
  fn: () => Promise<void>;
}

export interface GroupQueueOptions extends GroupQueuePolicyOptions {
  setTimeoutFn?: typeof setTimeout;
  runnerControlPort?: ContinuationRunnerControlPort;
}
