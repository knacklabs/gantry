type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
    contentType?: string;
  }): Promise<T>;
};

type CreateMcpServerDraftInput = {
  appId?: string;
  name: string;
  displayName?: string;
  description?: string;
  transport: 'http' | 'sse' | 'stdio_template';
  config: {
    transport: 'http' | 'sse' | 'stdio_template';
    url?: string;
    templateId?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    callerIdentity?: {
      mode: 'disabled' | 'required';
      headerName: string;
      signingRef: string;
      source: {
        kind: 'conversation_jid_phone';
        jidPrefix: string;
      };
    };
  };
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
    drafts: {
      create: (input: CreateMcpServerDraftInput) =>
        transport.request<Record<string, unknown>>({
          method: 'POST',
          path: '/v1/mcp-servers/drafts',
          body: input,
        }),
      list: (input: PageInput = {}) =>
        transport.request<{ drafts: unknown[] }>({
          method: 'GET',
          path: `/v1/mcp-servers/drafts${pageQuery(input)}`,
        }),
      approve: (
        serverId: string,
        input: { appId?: string; approvedBy?: string } = {},
      ) =>
        transport.request<Record<string, unknown>>({
          method: 'POST',
          path: `/v1/mcp-servers/drafts/${encodeURIComponent(serverId)}/approve`,
          body: input,
        }),
      reject: (
        serverId: string,
        input: { appId?: string; rejectedBy?: string; reason?: string } = {},
      ) =>
        transport.request<Record<string, unknown>>({
          method: 'POST',
          path: `/v1/mcp-servers/drafts/${encodeURIComponent(serverId)}/reject`,
          body: input,
        }),
    },
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
      input: { appId?: string; testedBy?: string } = {},
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
        versionId?: string;
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
        versionId?: string;
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
