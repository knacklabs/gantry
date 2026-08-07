import type {
  ModelDefaultsPatchRequest,
  ModelDefaultsResponse,
  ModelPreviewRequest,
  ModelPreviewResponse,
  ModelRecord,
} from './job-model-types.js';
import type { RequestOptions } from './types.js';
import type {
  ModelCredentialListResponse,
  ModelCredentialMutationResponse,
  ModelCredentialPatchRequest,
  ModelCredentialWriteRequest,
} from './openapi-types.js';

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
    credentials: {
      list: () =>
        transport.request<ModelCredentialListResponse>({
          method: 'GET',
          path: '/v1/credentials/models',
        }),
      put: (providerId: string, input: ModelCredentialWriteRequest) =>
        transport.request<ModelCredentialMutationResponse>({
          method: 'PUT',
          path: `/v1/credentials/models/${encodeURIComponent(providerId)}`,
          body: input,
        }),
      patch: (providerId: string, input: ModelCredentialPatchRequest) =>
        transport.request<ModelCredentialMutationResponse>({
          method: 'PATCH',
          path: `/v1/credentials/models/${encodeURIComponent(providerId)}`,
          body: input,
        }),
      disable: (providerId: string) =>
        transport.request<ModelCredentialMutationResponse>({
          method: 'DELETE',
          path: `/v1/credentials/models/${encodeURIComponent(providerId)}`,
        }),
    },
  };
}
