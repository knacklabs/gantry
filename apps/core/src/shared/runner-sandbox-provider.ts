import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type RunnerSandboxProviderId = 'direct' | 'sandbox_runtime';
export type RunnerSandboxNetworkMode = 'none' | 'required';
export type RunnerSandboxFilesystemMode = 'read_only' | 'workspace_write';

export interface RunnerSandboxResourceLimits {
  cpuSeconds: number;
  memoryMb: number;
  maxProcesses: number;
}

export interface RunnerSandboxProviderSelection {
  provider: RunnerSandboxProviderId;
  resourceLimits: RunnerSandboxResourceLimits;
}

export interface RunnerSandboxProfile {
  id: string;
  network: RunnerSandboxNetworkMode;
  filesystem: RunnerSandboxFilesystemMode;
}

export interface RunnerSandboxPrincipal {
  appId?: string;
  agentId?: string;
  conversationId?: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
}

export interface RunnerSandboxSpawnInput {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  cwd: string;
  workspaceRoot: string;
  configFilePath?: string;
  egressProxyUrl?: string;
  allowedNetworkHosts: readonly string[];
  runtimeReadPaths: readonly string[];
  runtimeWritePaths: readonly string[];
  protectedReadPaths: readonly string[];
  protectedWritePaths: readonly string[];
  resourceLimits: RunnerSandboxResourceLimits;
  sandboxProfile: RunnerSandboxProfile;
  principal: RunnerSandboxPrincipal;
}

export interface RunnerSandboxProvider {
  readonly id: RunnerSandboxProviderId;
  readonly enforcing: boolean;
  start(input: RunnerSandboxSpawnInput): ChildProcessWithoutNullStreams;
}
