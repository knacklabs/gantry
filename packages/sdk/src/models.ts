import type {
  ModelDefaultsPatchRequest,
  ModelDefaultsResponse,
  ModelPreviewRequest,
  ModelPreviewResponse,
  ModelRecord,
} from './job-model-types.js';
import type { RequestOptions } from './types.js';

export type ProviderModelAvailability =
  | 'ready'
  | 'available_to_register'
  | 'configured_not_advertised'
  | 'availability_unknown';

export type ProviderModelListing = {
  providerId: string;
  providerLabel: string;
  discoverySource: 'live' | 'cache' | 'none';
  refreshedAt: string | null;
  refreshError: string | null;
  models: Array<{
    providerModelId: string;
    displayName: string;
    aliases: string[];
    registered: boolean;
    availability: ProviderModelAvailability;
    source: 'registered' | 'live' | 'registered_and_live';
    deprecated: boolean;
  }>;
};

export type RegisterProviderModelInput = {
  providerId: string;
  providerModelId: string;
  alias: string;
  expectedRevision: number;
};

export type RegisterProviderModelResult = Omit<
  RegisterProviderModelInput,
  'expectedRevision'
> & {
  revision: number;
};

type ModelsTransport = {
  request<T>(options: RequestOptions): Promise<T>;
};

export function createModelsClient(transport: ModelsTransport) {
  return {
    list: () =>
      transport.request<{ models: ModelRecord[] }>({
        method: 'GET',
        path: '/v1/models',
      }),
    discover: (providerId: string, options?: { refresh?: boolean }) =>
      transport.request<ProviderModelListing>({
        method: 'GET',
        path: `/v1/model-providers/${encodeURIComponent(providerId)}/models${options?.refresh ? '?refresh=true' : ''}`,
      }),
    register: (input: RegisterProviderModelInput) =>
      transport.request<RegisterProviderModelResult>({
        method: 'POST',
        path: '/v1/model-registrations',
        body: input,
      }),
    defaults: {
      get: () =>
        transport.request<ModelDefaultsResponse>({
          method: 'GET',
          path: '/v1/models/defaults',
        }),
      update: (input: ModelDefaultsPatchRequest) =>
        transport.request<ModelDefaultsResponse>({
          method: 'PATCH',
          path: '/v1/models/defaults',
          body: input,
        }),
    },
    preview: (input: ModelPreviewRequest) =>
      transport.request<ModelPreviewResponse>({
        method: 'POST',
        path: '/v1/models/preview',
        body: input,
      }),
  };
}
