import type { SessionEventEnvelope, SseEvent } from './types.js';

type AppliedTypingOrder = {
  generation: number;
  sequenceCeilings: Map<number, number>;
};

type AppliedTypingState = {
  isTyping: boolean;
  observedAtMs: number;
  order?: AppliedTypingOrder;
};

export type SessionTypingInvalidation = {
  sessionId: string;
  threadId: string | null;
};

export type SessionTypingTrackerSeed = {
  sessionId: string;
  generation: number;
  targets?: ReadonlyArray<{
    threadId?: string | null;
    sequence: number;
  }>;
};

export const SESSION_TYPING_STALE_AFTER_MS = 15_000;

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
 * apply events can drain those cross-thread clears with
 * `takeInvalidatedTypingTargets`. `sessions.stream` yields durable events only;
 * ask this tracker for current typing state. A cursor-restoring consumer must
 * call `seed` with its durable per-session generation and per-thread sequence
 * baselines before applying resumed events. Typing state older than the
 * bounded staleness window is reported as not typing. Dispose releases the
 * tracker's bounded consumer lifetime.
 */
export class SessionTypingTracker {
  private readonly appliedByTarget = new Map<string, AppliedTypingState>();
  private readonly highestGenerationBySession = new Map<string, number>();
  private invalidatedTypingTargets: SessionTypingInvalidation[] = [];
  private disposed = false;

  seed(input: SessionTypingTrackerSeed): void {
    if (this.disposed) {
      throw new Error('Session typing tracker has been disposed');
    }
    if (!input.sessionId) {
      throw new TypeError('Session typing tracker seed requires a session id');
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new TypeError(
        'Session typing tracker seed generation must be a positive safe integer',
      );
    }
    for (const target of input.targets ?? []) {
      if (!Number.isSafeInteger(target.sequence) || target.sequence < 0) {
        throw new TypeError(
          'Session typing tracker seed sequence must be a non-negative safe integer',
        );
      }
    }
    const sessionPrefix = `${input.sessionId}\n`;
    if (
      this.highestGenerationBySession.has(input.sessionId) ||
      [...this.appliedByTarget.keys()].some((target) =>
        target.startsWith(sessionPrefix),
      )
    ) {
      throw new Error(
        'Session typing tracker must be seeded before applying events for that session',
      );
    }
    this.highestGenerationBySession.set(input.sessionId, input.generation);
    for (const target of input.targets ?? []) {
      this.appliedByTarget.set(`${input.sessionId}\n${target.threadId ?? ''}`, {
        isTyping: false,
        observedAtMs: Date.now(),
        order: {
          generation: input.generation,
          sequenceCeilings: new Map([[input.generation, target.sequence]]),
        },
      });
    }
  }

  apply(event: SessionEventEnvelope): boolean {
    if (this.disposed) {
      throw new Error('Session typing tracker has been disposed');
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
      this.appliedByTarget.set(target, { isTyping, observedAtMs: Date.now() });
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
        state.observedAtMs = Date.now();
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
        observedAtMs: Date.now(),
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
    applied.observedAtMs = Date.now();
    return true;
  }

  isTyping(sessionId: string, threadId?: string | null): boolean | undefined {
    if (this.disposed) {
      throw new Error('Session typing tracker has been disposed');
    }
    const applied = this.appliedByTarget.get(`${sessionId}\n${threadId ?? ''}`);
    if (
      applied?.isTyping &&
      Date.now() - applied.observedAtMs >= SESSION_TYPING_STALE_AFTER_MS
    ) {
      applied.isTyping = false;
    }
    return applied?.isTyping;
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
    streamPosition:
      typeof envelope?.streamPosition === 'number'
        ? envelope.streamPosition
        : input.eventId,
    eventType: input.eventType,
    sessionId:
      typeof envelope?.sessionId === 'string' || envelope?.sessionId === null
        ? envelope.sessionId
        : undefined,
    jobId:
      typeof envelope?.jobId === 'string' || envelope?.jobId === null
        ? envelope.jobId
        : undefined,
    runId:
      typeof envelope?.runId === 'string' || envelope?.runId === null
        ? envelope.runId
        : undefined,
    triggerId:
      typeof envelope?.triggerId === 'string' || envelope?.triggerId === null
        ? envelope.triggerId
        : undefined,
    conversationId:
      typeof envelope?.conversationId === 'string' ||
      envelope?.conversationId === null
        ? envelope.conversationId
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
