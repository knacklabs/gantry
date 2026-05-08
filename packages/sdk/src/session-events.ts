import type { SessionEventEnvelope, SseEvent } from './types.js';

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
