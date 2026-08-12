import type * as OpenApi from './openapi-types.js';
import type { RequestOptions, SseEvent } from './types.js';

type ActivityTransport = {
  request<T>(options: RequestOptions): Promise<T>;
  stream(pathname: string, signal?: AbortSignal): AsyncIterable<SseEvent>;
};

export function createActivityClient(transport: ActivityTransport) {
  return {
    list: () =>
      transport.request<OpenApi.ListActivityResponse>({
        method: 'GET',
        path: '/v1/activity',
      }),
    get: (runId: string) =>
      transport.request<OpenApi.GetActivityResponse>({
        method: 'GET',
        path: `/v1/activity/${encodeURIComponent(runId)}`,
      }),
    events: (
      runId: string,
      afterEventId?: OpenApi.ListActivityEventsQuery['afterEventId'],
    ) =>
      transport.request<OpenApi.ListActivityEventsResponse>({
        method: 'GET',
        path: eventsPath(runId, afterEventId),
      }),
    stream: (
      runId: string,
      input: OpenApi.ActivityEventStreamOptions = {},
    ): AsyncIterable<OpenApi.ActivityInvalidation> => {
      const events = transport.stream(
        eventsPath(runId, input.afterEventId),
        input.signal,
      );
      return (async function* () {
        for await (const event of events) {
          yield event.payload as OpenApi.ActivityInvalidation;
        }
      })();
    },
  };
}

function eventsPath(runId: string, afterEventId?: number): string {
  return `/v1/activity/${encodeURIComponent(runId)}/events${afterEventId ? `?afterEventId=${afterEventId}` : ''}`;
}
