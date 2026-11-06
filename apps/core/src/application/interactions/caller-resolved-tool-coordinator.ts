import {
  recordPendingInteractionRequested,
  resolvePendingInteractionRecord,
  updatePendingInteractionRecord,
} from './pending-interaction-durability.js';

const COMPLETED_TTL_MS = 5 * 60_000;
type Resolution =
  | { status: 'resolved'; result: unknown }
  | { status: 'rejected' | 'cancelled'; error: string };

interface PendingCallerTool {
  readonly appId: string;
  readonly runId?: string;
  readonly sourceAgentFolder: string;
  readonly interactionId: string;
  readonly toolName: string;
  readonly sensitiveResultFields: readonly string[];
  version: number;
  readonly resolve: (resolution: Resolution) => void;
  readonly timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingCallerTool>();
const completed = new Map<
  string,
  { idempotencyKey: string; expiresAt: number }
>();
const key = (sessionId: string, interactionId: string) =>
  `${sessionId}:${interactionId}`;

export async function requestCallerResolvedTool(input: {
  appId: string;
  runId?: string;
  sourceAgentFolder: string;
  sessionId: string;
  interactionId: string;
  toolName: string;
  toolInput: unknown;
  metadata?: Record<string, unknown>;
  sensitiveResultFields?: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
  emitRequired: () => Promise<void>;
}): Promise<unknown> {
  const entryKey = key(input.sessionId, input.interactionId);
  const result = new Promise<Resolution>((resolve) => {
    const timer = setTimeout(
      () =>
        resolve({
          status: 'rejected',
          error: 'Caller tool interaction expired.',
        }),
      input.timeoutMs,
    );
    pending.set(entryKey, {
      appId: input.appId,
      runId: input.runId,
      sourceAgentFolder: input.sourceAgentFolder,
      interactionId: input.interactionId,
      toolName: input.toolName,
      sensitiveResultFields: input.sensitiveResultFields ?? [],
      version: 1,
      resolve,
      timer,
    });
  });
  const abort = () =>
    pending.get(entryKey)?.resolve({
      status: 'cancelled',
      error: 'Caller tool interaction cancelled.',
    });
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    await recordPendingInteractionRequested({
      kind: 'question',
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.interactionId,
      appId: input.appId,
      runId: input.runId,
      ttlMs: input.timeoutMs,
      payload: {
        interactionType: 'caller_resolved_tool',
        sessionId: input.sessionId,
        interactionId: input.interactionId,
        toolName: input.toolName,
        toolInput: input.toolInput,
        interactionVersion: 1,
        ...input.metadata,
      },
    });
    await input.emitRequired();
    const resolution = await result;
    if (resolution.status !== 'resolved') throw new Error(resolution.error);
    return resolution.result;
  } finally {
    input.signal.removeEventListener('abort', abort);
    const active = pending.get(entryKey);
    if (active) clearTimeout(active.timer);
    pending.delete(entryKey);
  }
}

export async function updateCallerResolvedTool(input: {
  appId: string;
  sourceAgentFolder: string;
  sessionId: string;
  interactionId: string;
  expectedVersion: number;
  toolInput: unknown;
  metadata?: Record<string, unknown>;
}): Promise<number | null> {
  const active = pending.get(key(input.sessionId, input.interactionId));
  if (
    !active ||
    active.appId !== input.appId ||
    active.sourceAgentFolder !== input.sourceAgentFolder ||
    active.version !== input.expectedVersion
  ) {
    return null;
  }
  const nextVersion = active.version + 1;
  const persisted = await updatePendingInteractionRecord({
    appId: input.appId,
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.interactionId,
    update: (payload) => ({
      ...payload,
      toolInput: input.toolInput,
      interactionVersion: nextVersion,
      ...input.metadata,
    }),
  });
  if (!persisted) return null;
  active.version = nextVersion;
  return nextVersion;
}

export async function settleCallerResolvedTool(input: {
  appId: string;
  sessionId: string;
  interactionId: string;
  idempotencyKey: string;
  resolution: Resolution;
  interactionVersion?: number;
  approverRef?: string | null;
}): Promise<'resolved' | 'idempotent' | 'not_found' | 'conflict' | 'stale'> {
  const now = Date.now();
  for (const [entryKey, entry] of completed) {
    if (entry.expiresAt <= now) completed.delete(entryKey);
  }
  const entryKey = key(input.sessionId, input.interactionId);
  const previous = completed.get(entryKey);
  if (previous) {
    return previous.idempotencyKey === input.idempotencyKey
      ? 'idempotent'
      : 'conflict';
  }
  const active = pending.get(entryKey);
  if (!active || active.appId !== input.appId) return 'not_found';
  if (
    input.resolution.status === 'resolved' &&
    active.version > 1 &&
    input.interactionVersion !== active.version
  ) {
    return 'stale';
  }
  const persisted = await resolvePendingInteractionRecord({
    kind: 'question',
    sourceAgentFolder: active.sourceAgentFolder,
    requestId: active.interactionId,
    appId: active.appId,
    runId: active.runId,
    status: input.resolution.status === 'resolved' ? 'resolved' : 'cancelled',
    resolution: durableCallerToolResolution(
      active.sensitiveResultFields,
      input.resolution,
    ),
    approverRef: input.approverRef,
  });
  if (!persisted) return 'conflict';
  completed.set(entryKey, {
    idempotencyKey: input.idempotencyKey,
    expiresAt: now + COMPLETED_TTL_MS,
  });
  clearTimeout(active.timer);
  active.resolve(input.resolution);
  return 'resolved';
}

export function durableCallerToolResolution(
  sensitiveResultFields: readonly string[],
  resolution: Resolution,
): Resolution {
  if (resolution.status !== 'resolved' || sensitiveResultFields.length === 0) {
    return resolution;
  }
  const result = { ...record(resolution.result) };
  for (const field of sensitiveResultFields) {
    if (Object.hasOwn(result, field)) result[field] = '[REDACTED]';
  }
  return {
    status: 'resolved',
    result,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function cancelCallerResolvedTools(sessionId: string): number {
  let cancelled = 0;
  for (const [entryKey, active] of pending) {
    if (!entryKey.startsWith(`${sessionId}:`)) continue;
    active.resolve({
      status: 'cancelled',
      error: 'Caller tool interaction cancelled.',
    });
    cancelled += 1;
  }
  return cancelled;
}
