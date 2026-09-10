import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';

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
    // Aborts are wrapped too: a denied tool cuts the stream with a bare
    // AbortError and its usage must survive (T1-AC2). Consumers that need to
    // recognise an abort read `cause`.
    throw isDeepAgentPartialUsage(error) ? error : onError(error);
  }
}
