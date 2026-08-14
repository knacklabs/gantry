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
    inventory: () =>
      transport.request<{
        inventory: {
          tools: Array<{
            id: string;
            name: string;
            displayName?: string;
            description?: string | null;
            risk: string;
            selectable: boolean;
            status: string;
          }>;
          mcpServers: Array<{
            id: string;
            name: string;
            displayName?: string;
            description?: string | null;
          }>;
        };
      }>({
        method: 'GET',
        path: '/v1/inventory',
      }),
  };
}
