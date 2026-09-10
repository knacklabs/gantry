import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';
import { isAbortError } from './live-control.js';

export class DeepAgentPartialUsage {
  readonly kind = 'deep_agent_partial_usage';
  readonly message: string;

  constructor(
    readonly cause: unknown,
    readonly usage: NormalizedModelUsage,
    readonly contextUsage: RuntimeContextUsageSnapshot,
    readonly usageEventId: string,
  ) {
    this.message = cause instanceof Error ? cause.message : String(cause);
  }
}

export function isDeepAgentPartialUsage(
  value: unknown,
): value is DeepAgentPartialUsage {
  return (
    value instanceof DeepAgentPartialUsage ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { kind?: unknown }).kind === 'deep_agent_partial_usage')
  );
}

// One usage event id per model turn, unique ACROSS runner processes: the
// resumable session id repeats after a restart and the turn counter restarts
// at 1, so a per-process nonce (the Claude runner's queryRunId pattern) keeps
// idempotent consumers from collapsing a later run onto an earlier one.
export function deepAgentUsageEventIdForTurn(
  sessionId: string,
  turn: number,
  runNonce?: string,
): string {
  return runNonce
    ? `${sessionId}:run:${runNonce}:${turn}`
    : `${sessionId}:run:${turn}`;
}

export async function* partialUsageEvents<T>(
  events: AsyncIterable<T>,
  onError: (error: unknown) => DeepAgentPartialUsage,
): AsyncIterable<T> {
  try {
    for await (const event of events) yield event;
  } catch (error) {
    // Aborts keep their identity (a close-driven abort is a graceful stop);
    // normalizeDeepAgentStream attaches the partial usage to them instead.
    if (isAbortError(error)) throw error;
    throw onError(error);
  }
}

const ABORT_PARTIAL_USAGE = Symbol('DeepAgentAbortPartialUsage');

// A denied tool cuts the stream with a bare AbortError; its usage must still
// survive (T1-AC2) without changing the abort's identity, so the partial usage
// rides on the abort as a non-enumerable property.
export function attachAbortPartialUsage(
  abort: unknown,
  partial: DeepAgentPartialUsage,
): unknown {
  if (typeof abort === 'object' && abort !== null) {
    Object.defineProperty(abort, ABORT_PARTIAL_USAGE, {
      value: partial,
      enumerable: false,
    });
  }
  return abort;
}

export function abortPartialUsage(
  error: unknown,
): DeepAgentPartialUsage | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const partial = (error as Record<symbol, unknown>)[ABORT_PARTIAL_USAGE];
  return isDeepAgentPartialUsage(partial) ? partial : undefined;
}
