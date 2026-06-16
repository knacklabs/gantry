import type { IpcDeps } from './ipc-domain-types.js';

interface ScheduledInteractionIpcRequest {
  jobId?: string;
  runId?: string;
  targetJid?: string;
  threadId?: string;
}

export async function validatePermissionIpcJobExecutionTarget(input: {
  request: ScheduledInteractionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<void> {
  await validateScheduledInteractionIpcJobExecutionTarget({
    ...input,
    kind: 'permission',
  });
}

export async function validateUserQuestionIpcJobExecutionTarget(input: {
  request: ScheduledInteractionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<void> {
  await validateScheduledInteractionIpcJobExecutionTarget({
    ...input,
    kind: 'user question',
  });
}

async function validateScheduledInteractionIpcJobExecutionTarget(input: {
  request: ScheduledInteractionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  kind: 'permission' | 'user question';
}): Promise<void> {
  const { request, sourceAgentFolder, deps, kind } = input;
  if (!request.jobId) return;

  if (!request.targetJid) {
    throw new Error(`Scheduled job ${kind} IPC requires targetJid`);
  }
  if (!request.runId) {
    throw new Error(`Scheduled job ${kind} IPC requires runId`);
  }

  const job = await deps.opsRepository.getJobById(request.jobId);
  if (!job) {
    throw new Error(`Scheduled job ${kind} IPC references unknown job`);
  }
  const execution = job.execution_context;
  if (!execution?.conversationJid) {
    throw new Error(
      `Scheduled job ${kind} IPC requires canonical execution_context`,
    );
  }
  const executionWorkspaceKey =
    normalizeNullableString(execution.workspaceKey) ??
    normalizeNullableString(job.workspace_key);
  if (executionWorkspaceKey && executionWorkspaceKey !== sourceAgentFolder) {
    throw new Error(
      `Scheduled job ${kind} IPC source does not match job execution context`,
    );
  }
  if (execution.conversationJid !== request.targetJid) {
    throw new Error(
      `Scheduled job ${kind} IPC target does not match job execution context`,
    );
  }
  if (
    normalizeNullableString(execution.threadId) !==
    normalizeNullableString(request.threadId)
  ) {
    throw new Error(
      `Scheduled job ${kind} IPC thread does not match job execution context`,
    );
  }

  const run = await deps.opsRepository.getJobRunById(request.runId);
  if (!run || run.job_id !== request.jobId) {
    throw new Error(`Scheduled job ${kind} IPC run does not match job`);
  }
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
