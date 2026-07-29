import type {
  AgentFailureMetadata,
  PublicAsyncTaskDto,
} from '../domain/ports/async-tasks.js';
import type { RunnerSandboxResourceLimits } from '../shared/runner-sandbox-provider.js';
import type { AsyncCommandOutputSnapshot } from './async-command-task-helpers.js';

export interface AsyncCommandLaunchControl {
  directory: string;
  pidFile: string;
  pgidFile: string;
  readyFile: string;
  continueFile: string;
}

export interface AsyncCommandRunnerResult {
  outputSummary?: string | null;
  errorSummary?: string | null;
  failure?: AgentFailureMetadata;
}

export interface AsyncCommandProcessHandle {
  pid: number;
  processGroupId?: number | null;
  detached: boolean;
  platform: NodeJS.Platform;
  ownerPid: number;
  startedAt: string;
  processStartId?: string;
}

export interface AsyncCommandRunner {
  run(input: {
    command: string;
    cwd?: string;
    signal: AbortSignal;
    appId: string;
    agentId: string;
    conversationId: string;
    threadId?: string | null;
    parentRunId?: string | null;
    parentJobId?: string | null;
    protectedReadPaths?: readonly string[];
    protectedWritePaths?: readonly string[];
    allowedNetworkHosts?: readonly string[];
    egressProxyUrl?: string;
    resourceLimits?: RunnerSandboxResourceLimits;
    onProcessStarted?: (
      handle: AsyncCommandProcessHandle,
    ) => Promise<void> | void;
    onOutputSnapshot?: (snapshot: AsyncCommandOutputSnapshot) => unknown;
    launchControl?: AsyncCommandLaunchControl;
  }): Promise<AsyncCommandRunnerResult>;
}

export interface StartAsyncCommandTaskInput {
  appId: string;
  agentId: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentTaskId?: string | null;
  parentJobId?: string | null;
  parentJobRunId?: string | null;
  command: string;
  cwd?: string;
  protectedReadPaths?: readonly string[];
  protectedWritePaths?: readonly string[];
  allowedNetworkHosts?: readonly string[];
  egressProxyUrl?: string;
  resourceLimits?: RunnerSandboxResourceLimits;
  allowedToolRules: readonly string[];
  memoryBlock?: string;
  isScheduledJob?: boolean;
}

export type StartAsyncCommandTaskResult =
  | { ok: true; task: PublicAsyncTaskDto }
  | { ok: false; message: string };
