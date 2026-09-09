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

export function deepAgentUsageEventIdForTurn(
  sessionId: string,
  turn: number,
): string {
  return `${sessionId}:run:${turn}`;
}

export async function* partialUsageEvents<T>(
  events: AsyncIterable<T>,
  onError: (error: unknown) => DeepAgentPartialUsage,
): AsyncIterable<T> {
  try {
    for await (const event of events) yield event;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw onError(error);
  }
}
