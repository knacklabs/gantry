type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
    contentType?: string;
  }): Promise<T>;
};

type ConnectMcpServerInput = {
  appId?: string;
  name: string;
  displayName?: string;
  description?: string;
  transport: 'http' | 'sse' | 'stdio_template';
  config: Record<string, unknown>;
  allowedToolPatterns?: string[];
  autoApproveToolPatterns?: string[];
  credentialRefs?: Array<{
    name: string;
    target: 'env' | 'header';
    key: string;
  }>;
  sandboxProfileId?: string;
  riskClass?: 'low' | 'medium' | 'high';
  createdBy?: string;
  requestedReason?: string;
};

type PageInput = {
  limit?: number;
  cursor?: string;
};

function pageQuery(input: PageInput = {}): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.cursor) params.set('cursor', input.cursor);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function createMcpServersClient(transport: TransportLike) {
  return {
    connect: (input: ConnectMcpServerInput) =>
      transport.request<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/mcp-servers',
        body: input,
      }),
    list: (input: { status?: string } & PageInput = {}) => {
      const params = new URLSearchParams();
      if (input.status) params.set('status', input.status);
      if (input.limit !== undefined) params.set('limit', String(input.limit));
      if (input.cursor) params.set('cursor', input.cursor);
      return transport.request<{ servers: unknown[] }>({
        method: 'GET',
        path: `/v1/mcp-servers${params.toString() ? `?${params}` : ''}`,
      });
    },
    get: (serverId: string) =>
      transport.request<Record<string, unknown>>({
        method: 'GET',
        path: `/v1/mcp-servers/${encodeURIComponent(serverId)}`,
      }),
    disable: (
      serverId: string,
      input: { appId?: string; disabledBy?: string; reason?: string } = {},
    ) =>
      transport.request<Record<string, unknown>>({
        method: 'POST',
        path: `/v1/mcp-servers/${encodeURIComponent(serverId)}/disable`,
        body: input,
      }),
    test: (
      serverId: string,
      input: { appId?: string; testedBy?: string; agentId?: string } = {},
    ) =>
      transport.request<Record<string, unknown>>({
        method: 'POST',
        path: `/v1/mcp-servers/${encodeURIComponent(serverId)}/test`,
        body: input,
      }),
  };
}

export function createAgentMcpServersClient(transport: TransportLike) {
  return {
    list: (agentId: string, input: PageInput = {}) =>
      transport.request<{ bindings: unknown[] }>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers${pageQuery(input)}`,
      }),
    enable: (
      agentId: string,
      serverId: string,
      input: {
        appId?: string;
        required?: boolean;
        permissionPolicyIds?: string[];
      } = {},
    ) =>
      transport.request<Record<string, unknown>>({
        method: 'PUT',
        path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(serverId)}`,
        body: input,
      }),
    update: (
      agentId: string,
      serverId: string,
      input: {
        appId?: string;
        required?: boolean;
        permissionPolicyIds?: string[];
      },
    ) =>
      transport.request<Record<string, unknown>>({
        method: 'PATCH',
        path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(serverId)}`,
        body: input,
      }),
    disable: (agentId: string, serverId: string) =>
      transport.request<{ disabled: boolean; binding?: unknown }>({
        method: 'DELETE',
        path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(serverId)}`,
      }),
  };
}
