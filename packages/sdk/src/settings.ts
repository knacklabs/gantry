type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T>;
};

export type RuntimeSettingsResponse = {
  settings: {
    agent: {
      name: string;
      defaultModel: string;
    };
    memory: {
      enabled: boolean;
      dreaming: {
        enabled: boolean;
      };
    };
  };
};

export type UpdateRuntimeSettingsRequest = {
  agent?: {
    name?: string;
    defaultModel?: string;
  };
  memory?: {
    enabled?: boolean;
    dreaming?: {
      enabled?: boolean;
    };
  };
};

export type UpdateRuntimeSettingsResponse = RuntimeSettingsResponse & {
  changed: string[];
  restartRequired: boolean;
};

export function createSettingsClient(transport: TransportLike) {
  return {
    get: () =>
      transport.request<RuntimeSettingsResponse>({
        method: 'GET',
        path: '/v1/settings',
      }),
    update: (input: UpdateRuntimeSettingsRequest) =>
      transport.request<UpdateRuntimeSettingsResponse>({
        method: 'PATCH',
        path: '/v1/settings',
        body: input,
      }),
  };
}
