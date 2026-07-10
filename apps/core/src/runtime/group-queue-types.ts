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

export interface GroupMessageRunContext {
  finalRetry: boolean;
  responseSchema?: Record<string, unknown>;
}

export type GroupMessageEnqueueContext = Pick<
  GroupMessageRunContext,
  'responseSchema'
>;

export interface QueuedMessageSignal {
  responseSchema?: Record<string, unknown>;
}

export type ProcessMessagesFn = (
  groupJid: string,
  context: GroupMessageRunContext,
) => Promise<boolean>;

export type ContinuationRunnerControlPort = Pick<
  RunnerControlPort,
  'writeContinuationInput' | 'writeCloseSignal'
>;

export const RUNNER_CONTROL_PORT = Symbol.for('gantry.runnerControlPort');

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

export interface GroupStateFields {
  active: boolean;
  idleWaiting: boolean;
  isTaskRun: boolean;
  runningTaskId: string | null;
  pendingMessages: QueuedMessageSignal[];
  pendingTasks: QueuedTask[];
  runHandle: string | null;
  workspaceFolder: string | null;
  threadId: string | null;
  requiredContinuationUserId: string | null;
  retryCount: number;
  continuationHandler: ContinuationHandler | null;
}

export function isGroupStateIdle(
  state: GroupStateFields & { process: unknown },
): boolean {
  return (
    !state.active &&
    state.pendingMessages.length === 0 &&
    state.pendingTasks.length === 0 &&
    !state.runningTaskId &&
    !state.process &&
    !state.idleWaiting
  );
}

export function enqueuePendingMessageSignal(
  pendingMessages: QueuedMessageSignal[],
  signal: QueuedMessageSignal,
): void {
  if (
    signal.responseSchema === undefined &&
    pendingMessages.at(-1)?.responseSchema === undefined &&
    pendingMessages.length > 0
  ) {
    return;
  }
  pendingMessages.push(signal);
}

export interface GroupQueueOptions extends GroupQueuePolicyOptions {
  setTimeoutFn?: typeof setTimeout;
  runnerControlPort?: ContinuationRunnerControlPort;
}
