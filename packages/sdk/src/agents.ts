import type * as OpenApi from './openapi-types.js';

type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T>;
};

export type AgentAdminBoundConversation = {
  conversationId: string;
  provider: string;
  kind: string;
  displayName?: string;
  senderPolicy?: {
    allow: '*' | string[];
    mode: 'trigger';
  };
  requiresTrigger?: boolean;
  trigger?: string;
  approverUserIds: string[];
};

export type AgentAdminResponse = {
  agent: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  boundConversations: AgentAdminBoundConversation[];
};

export type AgentProfileFileKind = 'soul' | 'agents';

export type AgentProfileFileSummary = {
  kind: AgentProfileFileKind;
  path: string;
  version: number;
  contentHash: string;
  sizeBytes: number;
  updatedAt: string | null;
};

export type AgentProfileFilesResponse = {
  agentId: string;
  files: AgentProfileFileSummary[];
};

export type AgentProfileFileContentResponse = {
  agentId: string;
  kind: AgentProfileFileKind;
  path: string;
  version: number;
  contentHash: string;
  content: string;
};

export type AgentAccessSelection = { id: string; version: string };
export type AgentAccessDocument = {
  agentId: string;
  sources: { skills: unknown[]; mcpServers: unknown[]; tools: unknown[] };
  selections: AgentAccessSelection[];
  toolAccess?: unknown;
  summary?: unknown;
  updatedAt?: string;
};

export function createAgentAdminClient(transport: TransportLike) {
  return {
    list: () =>
      transport.request<OpenApi.ListAgentsResponse>({
        method: 'GET',
        path: '/v1/agents',
      }),
    create: (body: OpenApi.CreateAgentRequest) =>
      transport.request<OpenApi.CreateAgentResponse>({
        method: 'POST',
        path: '/v1/agents',
        body,
      }),
    getAdmin: (agentId: string) =>
      transport.request<AgentAdminResponse>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/admin`,
      }),
    getDelegates: (agentId: string) =>
      transport.request<OpenApi.GetAgentDelegatesResponse>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/delegates`,
      }),
    replaceDelegates: (
      agentId: string,
      body: OpenApi.ReplaceAgentDelegatesRequest,
    ) =>
      transport.request<OpenApi.ReplaceAgentDelegatesResponse>({
        method: 'PUT',
        path: `/v1/agents/${encodeURIComponent(agentId)}/delegates`,
        body,
      }),
    listProfileFiles: (agentId: string) =>
      transport.request<AgentProfileFilesResponse>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/profile-files`,
      }),
    readProfileFile: (agentId: string, kind: AgentProfileFileKind) =>
      transport.request<AgentProfileFileContentResponse>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/profile-files/${kind}`,
      }),
    setProfileFile: (
      agentId: string,
      kind: AgentProfileFileKind,
      body: { content: string; expectedVersion?: number },
    ) =>
      transport.request<AgentProfileFileContentResponse>({
        method: 'PUT',
        path: `/v1/agents/${encodeURIComponent(agentId)}/profile-files/${kind}`,
        body,
      }),
    access: {
      get: (agentId: string) =>
        transport.request<AgentAccessDocument>({
          method: 'GET',
          path: `/v1/agents/${encodeURIComponent(agentId)}/access`,
        }),
      replace: (
        agentId: string,
        body: Pick<AgentAccessDocument, 'sources' | 'selections'>,
      ) =>
        transport.request<AgentAccessDocument>({
          method: 'PUT',
          path: `/v1/agents/${encodeURIComponent(agentId)}/access`,
          body,
        }),
    },
  };
}
