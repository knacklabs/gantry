import type * as OpenApi from './openapi-types.js';
import { querySuffix } from './query-string.js';
import type { RequestOptions, SseEvent, StreamOptions } from './types.js';

type ActivityTransport = {
  request<T>(options: RequestOptions): Promise<T>;
  stream(pathname: string, options?: StreamOptions): AsyncIterable<SseEvent>;
};

export function createActivityClient(transport: ActivityTransport) {
  return {
    list: (input: OpenApi.ListActivityQuery = {}) =>
      transport.request<OpenApi.ListActivityResponse>({
        method: 'GET',
        path: `/v1/activity${querySuffix(input)}`,
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
      const events = transport.stream(eventsPath(runId, input.afterEventId), {
        signal: input.signal,
        onOpen: input.onOpen,
      });
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
