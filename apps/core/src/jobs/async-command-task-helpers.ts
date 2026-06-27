import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  AsyncTaskCreateInput,
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import type {
  AsyncCommandLaunchControl,
  AsyncCommandProcessHandle,
  StartAsyncCommandTaskResult,
} from './async-command-task-service.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import { nowIso } from '../shared/time/datetime.js';

const OUTPUT_LIMIT = 1_000;
const localAdmissionLocks = new WeakMap<AsyncTaskRepository, Promise<void>>();

export function readPersistedProcessHandle(
  value: unknown,
): AsyncCommandProcessHandle | null {
  if (!isRecord(value) || !isRecord(value.process)) return null;
  const processHandle = value.process;
  const pid = Number(processHandle.pid);
  const processGroupId =
    processHandle.processGroupId === null ||
    processHandle.processGroupId === undefined
      ? null
      : Number(processHandle.processGroupId);
  const detached = processHandle.detached === true;
  const platform = processHandle.platform;
  const ownerPid = Number(processHandle.ownerPid);
  const startedAt = processHandle.startedAt;
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    (processGroupId !== null &&
      (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)) ||
    typeof platform !== 'string' ||
    ![
      'darwin',
      'linux',
      'win32',
      'freebsd',
      'openbsd',
      'aix',
      'sunos',
    ].includes(platform) ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    typeof startedAt !== 'string'
  ) {
    return null;
  }
  const handle: AsyncCommandProcessHandle = {
    pid,
    processGroupId,
    detached,
    platform: platform as NodeJS.Platform,
    ownerPid,
    startedAt,
    processStartId:
      typeof processHandle.processStartId === 'string'
        ? processHandle.processStartId
        : undefined,
  };
  return handle;
}

export function buildLaunchControl(taskId: string): AsyncCommandLaunchControl {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `gantry-async-${taskId}-`),
  );
  return {
    directory,
    pidFile: path.join(directory, 'pid'),
    pgidFile: path.join(directory, 'pgid'),
    readyFile: path.join(directory, 'ready'),
    continueFile: path.join(directory, 'continue'),
  };
}

export function cleanupLaunchControl(
  launchControl: AsyncCommandLaunchControl,
): void {
  fs.rmSync(launchControl.directory, { recursive: true, force: true });
}

export function terminateProcessHandle(
  handle: AsyncCommandProcessHandle,
): boolean {
  const target = handle.detached
    ? -(handle.processGroupId ?? handle.pid)
    : handle.pid;
  try {
    process.kill(target, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return false;
  }
  setTimeout(() => {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // The process already exited or the host cannot signal it.
    }
  }, 1_000).unref?.();
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function taskTimestampMs(task: AsyncTaskRecord): number {
  return Date.parse(task.heartbeatAt ?? task.updatedAt ?? task.createdAt);
}

export function commandSummary(command: string): string {
  return command.length <= 120 ? command : `${command.slice(0, 117)}...`;
}

export function truncate(value: string, limit = OUTPUT_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function outputTail(value: string, limit = OUTPUT_LIMIT): string {
  return value.length <= limit ? value : `...${value.slice(-limit)}`;
}

export interface AsyncCommandOutputSnapshot {
  stdoutTail?: string;
  stderrTail?: string;
}

export async function persistProcessHandle(input: {
  repository: AsyncTaskRepository;
  task: AsyncTaskRecord;
  handle: AsyncCommandProcessHandle;
}): Promise<void> {
  const latest = (await input.repository.getTask(input.task.id)) ?? input.task;
  if (
    latest.leaseToken !== input.task.leaseToken ||
    latest.fencingVersion !== input.task.fencingVersion
  ) {
    throw new Error('Async command process owner is stale.');
  }
  const updated = await input.repository.transitionTask({
    taskId: input.task.id,
    leaseToken: input.task.leaseToken,
    fencingVersion: input.task.fencingVersion,
    status: 'running',
    now: nowIso(),
    heartbeatAt: nowIso(),
    privateCorrelationJson: {
      ...(isRecord(latest.privateCorrelationJson)
        ? latest.privateCorrelationJson
        : {}),
      process: input.handle,
    },
  });
  if (!updated) {
    throw new Error('Failed to persist async command process handle.');
  }
}

export async function persistInspectionSnapshot(input: {
  repository: AsyncTaskRepository;
  task: AsyncTaskRecord;
  snapshot: AsyncCommandOutputSnapshot;
}): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = await input.repository.getTask(input.task.id);
    if (
      !latest ||
      latest.status !== 'running' ||
      latest.leaseToken !== input.task.leaseToken ||
      latest.fencingVersion !== input.task.fencingVersion
    ) {
      return;
    }
    const now = nowIso();
    const progress = isRecord(latest.privateCorrelationJson.progress)
      ? latest.privateCorrelationJson.progress
      : {};
    const updated = await input.repository.transitionTask({
      taskId: input.task.id,
      leaseToken: input.task.leaseToken,
      fencingVersion: input.task.fencingVersion,
      status: 'running',
      now,
      heartbeatAt: now,
      expectedPrivateCorrelationJson: latest.privateCorrelationJson,
      privateCorrelationJson: {
        ...(isRecord(latest.privateCorrelationJson)
          ? latest.privateCorrelationJson
          : {}),
        progress: {
          ...progress,
          phase: 'running',
          stdoutTail: outputTail(
            sanitizeOutboundLlmText(input.snapshot.stdoutTail ?? '').text,
          ),
          stderrTail: outputTail(
            sanitizeOutboundLlmText(input.snapshot.stderrTail ?? '').text,
          ),
        },
      },
    });
    if (updated) return;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isTimeoutError(err: unknown): boolean {
  return /timed out|timeout/i.test(errorMessage(err));
}

export function admissionFailure(reason: 'app_capacity' | 'agent_capacity'): {
  ok: false;
  message: string;
} {
  return {
    ok: false,
    message:
      reason === 'app_capacity'
        ? 'Async command capacity is full for this app. Wait for an existing task to finish or cancel one.'
        : 'Async command capacity is full for this agent. Wait for an existing task to finish or cancel one.',
  };
}

export async function withLocalAdmissionLock<T>(
  repository: AsyncTaskRepository,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = localAdmissionLocks.get(repository) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  localAdmissionLocks.set(
    repository,
    previous.then(
      () => current,
      () => current,
    ),
  );
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (localAdmissionLocks.get(repository) === current) {
      localAdmissionLocks.delete(repository);
    }
  }
}

export function taskInScope(
  task: AsyncTaskRecord,
  input: {
    appId: string;
    agentId: string;
    conversationId?: string | null;
    threadId?: string | null;
    parentTaskId?: string | null;
  },
): boolean {
  return (
    task.appId === input.appId &&
    task.agentId === input.agentId &&
    (input.conversationId === undefined ||
      task.conversationId === input.conversationId) &&
    (input.threadId === undefined || task.threadId === input.threadId) &&
    (input.parentTaskId === undefined ||
      task.privateCorrelationJson.parentTaskId === input.parentTaskId)
  );
}

export function hasAsyncTaskRepository(deps: {
  getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
}): boolean {
  try {
    return Boolean(deps.getAsyncTaskRepository?.());
  } catch {
    return false;
  }
}

export type AdmissionResult =
  | { ok: true; task: AsyncTaskRecord }
  | { ok: false; reason: 'app_capacity' | 'agent_capacity' };

export type AsyncTaskAdmissionInput = AsyncTaskCreateInput;
export type AsyncCommandStartResult = StartAsyncCommandTaskResult;
