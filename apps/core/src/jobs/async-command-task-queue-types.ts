import type { AsyncTaskRecord } from '../domain/ports/async-tasks.js';
import type {
  AsyncCommandLaunchControl,
  AsyncCommandProcessHandle,
  StartAsyncCommandTaskInput,
} from './async-command-task-service.js';
import type {
  PendingDelegatedAgentExecution,
  StartDelegatedAgentTaskInput,
} from './async-delegated-agent-task.js';

export type PendingAsyncCommandExecution = {
  task: AsyncTaskRecord;
  command: string;
  input: Pick<
    StartAsyncCommandTaskInput,
    | 'cwd'
    | 'protectedReadPaths'
    | 'protectedWritePaths'
    | 'allowedNetworkHosts'
    | 'egressProxyUrl'
    | 'resourceLimits'
  >;
  controller: AbortController;
  launchControl: AsyncCommandLaunchControl;
  delegated?: never;
};

export type PendingAsyncTaskExecution =
  | PendingAsyncCommandExecution
  | PendingDelegatedAgentExecution;

export interface AsyncCommandTaskServiceOptions {
  terminateProcess?: (handle: AsyncCommandProcessHandle) => boolean;
  createRecoveredDelegatedAgentRun?: (
    task: AsyncTaskRecord,
    input: Omit<StartDelegatedAgentTaskInput, 'run'>,
  ) => StartDelegatedAgentTaskInput['run'];
  prepareRun?: (input: {
    task: AsyncTaskRecord;
    allowedNetworkHosts?: readonly string[];
  }) => Promise<
    | {
        egressProxyUrl?: string;
        cleanup?: () => Promise<void> | void;
      }
    | undefined
  >;
}
