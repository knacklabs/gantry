type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
    contentType?: string;
  }): Promise<T>;
};

type InstallSkillInput = {
  appId?: string;
  agentId?: string;
  createdBy?: string;
  zip: Uint8Array;
};

export function createSkillsClient(transport: TransportLike) {
  return {
    install: (input: InstallSkillInput) => {
      const params = new URLSearchParams();
      if (input.appId) params.set('appId', input.appId);
      if (input.agentId) params.set('agentId', input.agentId);
      if (input.createdBy) params.set('createdBy', input.createdBy);
      return transport.request<Record<string, unknown>>({
        method: 'POST',
        path: `/v1/skills/install${params.toString() ? `?${params}` : ''}`,
        body: input.zip,
        contentType: 'application/zip',
      });
    },
    list: (input: { agentId?: string } = {}) => {
      const params = new URLSearchParams();
      if (input.agentId) params.set('agentId', input.agentId);
      return transport.request<{ skills: unknown[] }>({
        method: 'GET',
        path: `/v1/skills${params.toString() ? `?${params}` : ''}`,
      });
    },
  };
}

export function createAgentSkillsClient(transport: TransportLike) {
  return {
    list: (agentId: string) =>
      transport.request<{ bindings: unknown[] }>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/skills`,
      }),
    enable: (
      agentId: string,
      skillId: string,
      input: { appId?: string } = {},
    ) =>
      transport.request<Record<string, unknown>>({
        method: 'PUT',
        path: `/v1/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
        body: input,
      }),
    disable: (agentId: string, skillId: string) =>
      transport.request<{ disabled: boolean; binding?: unknown }>({
        method: 'DELETE',
        path: `/v1/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
      }),
  };
}
