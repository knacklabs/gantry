import type { SessionEventEnvelope, SseEvent } from './types.js';

type AppliedTypingOrder = {
  generation: number;
  sequenceCeilings: Map<number, number>;
};

type AppliedTypingState = {
  isTyping: boolean;
  order?: AppliedTypingOrder;
};

export type SessionTypingInvalidation = {
  sessionId: string;
  threadId: string | null;
};

/**
 * Caller-owned latest-value tracker for App typing events.
 *
 * Publication can time out while its durable append later succeeds. That
 * narrow residual intentionally remains in the event log; consumers discard
 * an older orderedEnvelope sequence so a late stale `isTyping: true` can never
 * override a newer terminal `isTyping: false`. Raw history and wait reads stay
 * raw: the logical consumer explicitly retains this tracker across polls.
 * Generation is the durable runtime lease epoch for the App binding. Lower
 * producer epochs are rejected across the whole session, including an
 * A -> B -> A interleave. A newer producer clears typing left by the older
 * producer on every thread, while per-thread sequence ceilings still prevent
 * an older operation within the current epoch from reappearing. Callers that
 * apply events directly can drain those cross-thread clears with
 * `takeInvalidatedTypingTargets`; the SDK stream does this automatically and
 * yields synthetic typing-off events. Dispose releases the tracker's bounded
 * consumer lifetime.
 */
export class SessionTypingTracker {
  private readonly appliedByTarget = new Map<string, AppliedTypingState>();
  private readonly highestGenerationBySession = new Map<string, number>();
  private readonly lastObservedEventIdBySession = new Map<string, number>();
  private invalidatedTypingTargets: SessionTypingInvalidation[] = [];
  private disposed = false;

  apply(event: SessionEventEnvelope): boolean {
    if (this.disposed) {
      throw new Error('Session typing tracker has been disposed');
    }
    if (event.sessionId) {
      this.lastObservedEventIdBySession.set(
        event.sessionId,
        Math.max(
          this.lastObservedEventIdBySession.get(event.sessionId) ?? 0,
          event.eventId,
        ),
      );
    }
    if (event.eventType !== 'session.typing' || !event.sessionId) return true;
    const isTyping = typingValue(event.payload);
    if (isTyping === undefined) return true;
    const target = `${event.sessionId}\n${event.threadId ?? ''}`;
    const envelope = orderedEnvelope(event.payload);
    if (!envelope) {
      const applied = this.appliedByTarget.get(target);
      if (this.highestGenerationBySession.has(event.sessionId)) return false;
      if (applied?.order) return false;
      this.appliedByTarget.set(target, { isTyping });
      return true;
    }
    const highestGeneration = this.highestGenerationBySession.get(
      event.sessionId,
    );
    if (
      highestGeneration !== undefined &&
      envelope.generation < highestGeneration
    ) {
      return false;
    }
    if (
      highestGeneration === undefined ||
      envelope.generation > highestGeneration
    ) {
      this.highestGenerationBySession.set(event.sessionId, envelope.generation);
      const sessionPrefix = `${event.sessionId}\n`;
      for (const [appliedTarget, state] of this.appliedByTarget) {
        if (!appliedTarget.startsWith(sessionPrefix)) continue;
        if (appliedTarget !== target && state.isTyping) {
          this.invalidatedTypingTargets.push({
            sessionId: event.sessionId,
            threadId: appliedTarget.slice(sessionPrefix.length) || null,
          });
        }
        state.isTyping = false;
        state.order = {
          generation: envelope.generation,
          sequenceCeilings: new Map(),
        };
      }
    }
    const applied = this.appliedByTarget.get(target);
    if (!applied?.order) {
      this.appliedByTarget.set(target, {
        isTyping,
        order: {
          generation: envelope.generation,
          sequenceCeilings: new Map([[envelope.generation, envelope.sequence]]),
        },
      });
      return true;
    }
    if (envelope.generation < applied.order.generation) return false;
    const sequenceCeiling = applied.order.sequenceCeilings.get(
      envelope.generation,
    );
    if (sequenceCeiling !== undefined && envelope.sequence <= sequenceCeiling) {
      return false;
    }
    applied.order.sequenceCeilings.set(envelope.generation, envelope.sequence);
    applied.order.generation = envelope.generation;
    applied.isTyping = isTyping;
    return true;
  }

  afterEventId(sessionId: string): number | undefined {
    if (this.disposed) {
      throw new Error('Session typing tracker has been disposed');
    }
    return this.lastObservedEventIdBySession.get(sessionId);
  }

  isTyping(sessionId: string, threadId?: string | null): boolean | undefined {
    if (this.disposed) {
      throw new Error('Session typing tracker has been disposed');
    }
    return this.appliedByTarget.get(`${sessionId}\n${threadId ?? ''}`)
      ?.isTyping;
  }

  takeInvalidatedTypingTargets(): readonly SessionTypingInvalidation[] {
    if (this.disposed) {
      throw new Error('Session typing tracker has been disposed');
    }
    const invalidated = this.invalidatedTypingTargets;
    this.invalidatedTypingTargets = [];
    return invalidated;
  }

  dispose(): void {
    this.disposed = true;
    this.appliedByTarget.clear();
    this.highestGenerationBySession.clear();
    this.lastObservedEventIdBySession.clear();
    this.invalidatedTypingTargets = [];
  }
}

function typingValue(payload: unknown): boolean | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const { isTyping } = payload as { isTyping?: unknown };
  return typeof isTyping === 'boolean' ? isTyping : undefined;
}

function orderedEnvelope(
  payload: unknown,
): { generation: number; sequence: number } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const candidate = (payload as { orderedEnvelope?: unknown }).orderedEnvelope;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const { generation, kind, sequence } = candidate as Record<string, unknown>;
  if (
    kind !== 'typing' ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0
  ) {
    return undefined;
  }
  return { generation, sequence };
}

export function parseSessionSseEvent(input: {
  eventId: number;
  eventType: string;
  data: unknown;
}): SseEvent {
  const envelope =
    input.data && typeof input.data === 'object' && 'payload' in input.data
      ? (input.data as Partial<SessionEventEnvelope>)
      : undefined;
  return {
    eventId: input.eventId,
    eventType: input.eventType,
    sessionId:
      typeof envelope?.sessionId === 'string' || envelope?.sessionId === null
        ? envelope.sessionId
        : undefined,
    threadId:
      typeof envelope?.threadId === 'string' || envelope?.threadId === null
        ? envelope.threadId
        : undefined,
    correlationId:
      typeof envelope?.correlationId === 'string' ||
      envelope?.correlationId === null
        ? envelope.correlationId
        : undefined,
    createdAt:
      typeof envelope?.createdAt === 'string' ? envelope.createdAt : undefined,
    payload: envelope?.payload ?? input.data,
  };
}
