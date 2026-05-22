import type {
  ModelDefaultsPatchRequest,
  ModelDefaultsResponse,
  ModelPreviewRequest,
  ModelPreviewResponse,
  ModelRecord,
} from './job-model-types.js';
import type { RequestOptions } from './types.js';

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
  };
}
