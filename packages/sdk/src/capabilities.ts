import type * as OpenApi from './openapi-types.js';
import { querySuffix } from './query-string.js';

type TransportLike = {
  request<T>(options: { method: string; path: string }): Promise<T>;
};

export function createCapabilitiesClient(transport: TransportLike) {
  return {
    list: () =>
      transport.request<OpenApi.ListCapabilitiesResponse>({
        method: 'GET',
        path: `/v1/capabilities${querySuffix({})}`,
      }),
  };
}
