import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { RunnerRuntimeEventFrame } from './runner-frame.js';

export type TaskLifecycleEventKind =
  | 'started'
  | 'progress'
  | 'updated'
  | 'notification';

export interface TaskLifecycleContext {
  appId?: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
  conversationId?: string;
  threadId?: string;
  actor?: string;
}

export interface TaskLifecycleUsageInput {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface TaskLifecyclePatchInput {
  status?: string;
  description?: string;
  endTime?: number;
  totalPausedMs?: number;
  isBackgrounded?: boolean;
  hasError?: boolean;
}

export interface TaskLifecycleEventInput {
  kind: TaskLifecycleEventKind;
  taskId: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  taskType?: string;
  workflowName?: string;
  skipTranscript?: boolean;
  lastToolName?: string;
  summary?: string;
  status?: string;
  usage?: TaskLifecycleUsageInput;
  patch?: TaskLifecyclePatchInput;
}

const TASK_EVENT_TYPE_BY_KIND: Record<TaskLifecycleEventKind, string> = {
  started: RUNTIME_EVENT_TYPES.TASK_STARTED,
  progress: RUNTIME_EVENT_TYPES.TASK_PROGRESS,
  updated: RUNTIME_EVENT_TYPES.TASK_UPDATED,
  notification: RUNTIME_EVENT_TYPES.TASK_NOTIFICATION,
};

export function buildTaskLifecycleRuntimeEvent(
  context: TaskLifecycleContext,
  input: TaskLifecycleEventInput,
): RunnerRuntimeEventFrame | null {
  const taskId = input.taskId.trim();
  if (!taskId) return null;
  return {
    ...defined({
      appId: context.appId,
      agentId: context.agentId,
      runId: context.runId,
      jobId: context.jobId,
      conversationId: context.conversationId,
      threadId: context.threadId,
      actor: context.actor ?? 'runner',
    }),
    eventType: TASK_EVENT_TYPE_BY_KIND[input.kind],
    payload: payloadFor(input.kind, { ...input, taskId }),
  };
}

function payloadFor(
  kind: TaskLifecycleEventKind,
  input: TaskLifecycleEventInput,
): Record<string, unknown> {
  const base = defined({
    taskId: input.taskId,
    toolUseId: input.toolUseId,
  });
  if (kind === 'started') {
    return {
      ...base,
      ...defined({
        description: input.description,
        subagentType: input.subagentType,
        taskType: input.taskType,
        workflowName: input.workflowName,
      }),
      skipTranscript: input.skipTranscript === true,
    };
  }
  if (kind === 'progress') {
    return {
      ...base,
      ...defined({
        description: input.description,
        subagentType: input.subagentType,
        lastToolName: input.lastToolName,
        summary: input.summary,
        usage: sanitizedUsage(input.usage),
      }),
    };
  }
  if (kind === 'updated') {
    return {
      ...base,
      patch: defined({
        status: input.patch?.status,
        description: input.patch?.description,
        endTime: input.patch?.endTime,
        totalPausedMs: input.patch?.totalPausedMs,
        isBackgrounded: input.patch?.isBackgrounded,
        hasError: input.patch?.hasError,
      }),
    };
  }
  return {
    ...base,
    ...defined({
      status: input.status,
      summary: input.summary,
      usage: sanitizedUsage(input.usage),
    }),
    skipTranscript: input.skipTranscript === true,
  };
}

function sanitizedUsage(
  usage: TaskLifecycleUsageInput | undefined,
): TaskLifecycleUsageInput | undefined {
  if (!usage) return undefined;
  const out = defined({
    totalTokens: finite(usage.totalTokens),
    toolUses: finite(usage.toolUses),
    durationMs: finite(usage.durationMs),
  }) as TaskLifecycleUsageInput;
  return Object.keys(out).length > 0 ? out : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function defined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
