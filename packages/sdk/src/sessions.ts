import type * as OpenApi from './openapi-types.js';
import { SessionTypingTracker } from './session-events.js';
import type { RequestOptions, SseEvent } from './types.js';

type SessionTransport = {
  request<T>(options: RequestOptions): Promise<T>;
  stream(pathname: string, signal?: AbortSignal): AsyncIterable<SseEvent>;
};

export function createSessionsClient(transport: SessionTransport) {
  const streamEvents = async function* (
    pathname: string,
    signal?: AbortSignal,
    retainedTracker?: SessionTypingTracker,
  ): AsyncIterable<SseEvent> {
    const tracker = retainedTracker ?? new SessionTypingTracker();
    try {
      for await (const event of transport.stream(pathname, signal)) {
        const accepted = tracker.apply(event);
        if (accepted) yield event;
        for (const invalidated of tracker.takeInvalidatedTypingTargets()) {
          // Synthetic invalidations deliberately reuse the triggering durable
          // cursor and follow that event. Resuming from this id may redeliver
          // the idempotent typing event once, but never skips session history.
          yield {
            ...event,
            eventId: invalidated.eventId,
            eventType: 'session.typing',
            synthetic: true,
            sessionId: invalidated.sessionId,
            threadId: invalidated.threadId,
            payload: { isTyping: false },
          };
        }
      }
    } finally {
      if (!retainedTracker) tracker.dispose();
    }
  };

  return {
    createTypingTracker: () => new SessionTypingTracker(),
    ensure: (input: OpenApi.EnsureSessionRequest) =>
      transport.request<OpenApi.EnsureSessionResponse>({
        method: 'POST',
        path: '/v1/sessions/ensure',
        body: input,
      }),
    sendMessage: ({ sessionId, ...body }: OpenApi.SendSessionMessageInput) =>
      transport.request<OpenApi.SendSessionMessageResponse>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        body,
      }),
    listEvents: (
      sessionId: string,
      afterEventId?: OpenApi.ListSessionEventsQuery['afterEventId'],
    ) =>
      transport.request<OpenApi.ListSessionEventsResponse>({
        method: 'GET',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/events${afterEventId ? `?afterEventId=${afterEventId}` : ''}`,
      }),
    stream: (
      sessionId: string,
      input: OpenApi.SessionEventStreamOptions & {
        tracker?: SessionTypingTracker;
      } = {},
    ) => {
      const afterEventId = Math.max(
        input.afterEventId ?? 0,
        input.tracker?.afterEventId(sessionId) ?? 0,
      );
      return streamEvents(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events${afterEventId ? `?afterEventId=${afterEventId}` : ''}`,
        input.signal,
        input.tracker,
      );
    },
    wait: (sessionId: string, input: OpenApi.WaitForSessionEventQuery = {}) =>
      transport.request<OpenApi.WaitForSessionEventResponse>({
        method: 'GET',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/wait?afterEventId=${input.afterEventId || 0}&timeoutMs=${input.timeoutMs || 60_000}`,
      }),
  };
}
