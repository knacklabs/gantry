import type {
  DesiredStateResponse,
  DesiredStateUpdateRequest,
  DesiredStateUpdateResponse,
  RuntimeSettingsResponse,
  SettingsRevisionsResponse,
} from './openapi-types.js';

export type {
  DesiredStateResponse,
  DesiredStateUpdateRequest,
  DesiredStateUpdateResponse,
  RuntimeSettingsResponse,
  SettingsDocument,
  SettingsRevisionSummary,
  SettingsRevisionsResponse,
} from './openapi-types.js';

type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T>;
};

export function createSettingsClient(transport: TransportLike) {
  return {
    get: () =>
      transport.request<RuntimeSettingsResponse>({
        method: 'GET',
        path: '/v1/settings',
      }),
    getDesiredState: () =>
      transport.request<DesiredStateResponse>({
        method: 'GET',
        path: '/v1/settings/desired-state',
      }),
    updateDesiredState: (body: DesiredStateUpdateRequest) =>
      transport.request<DesiredStateUpdateResponse>({
        method: 'PUT',
        path: '/v1/settings/desired-state',
        body,
      }),
    listRevisions: () =>
      transport.request<SettingsRevisionsResponse>({
        method: 'GET',
        path: '/v1/settings/revisions',
      }),
  };
}
