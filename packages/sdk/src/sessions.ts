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
    // The stream is the durable event log. It neither inserts logical typing
    // events nor changes cursor semantics; ask the optional tracker for current
    // typing state after applying the durable events.
    for await (const event of transport.stream(pathname, signal)) {
      retainedTracker?.apply(event);
      yield event;
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
    resolveInteraction: (
      sessionId: string,
      interactionId: string,
      body: { idempotencyKey: string; result: unknown; resolvedBy?: string },
    ) =>
      transport.request<{ accepted: boolean; idempotent: boolean }>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/resolve`,
        body,
      }),
    rejectInteraction: (
      sessionId: string,
      interactionId: string,
      body: { idempotencyKey: string; reason?: string; resolvedBy?: string },
    ) =>
      transport.request<{ accepted: boolean; idempotent: boolean }>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/reject`,
        body,
      }),
    cancelTurn: (sessionId: string, body: { threadId?: string } = {}) =>
      transport.request<{ cancelled: boolean }>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/turns/current/cancel`,
        body,
      }),
    archive: (sessionId: string) =>
      transport.request<{
        archived: true;
        alreadyArchived: boolean;
        cancelled: boolean;
      }>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/archive`,
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
      const afterEventId = input.afterEventId ?? 0;
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
