type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T>;
};

export type AgentDmAccessEntry = {
  provider: string;
  userIds: string[];
  adminUserId?: string;
};

export type AgentAdminBoundConversation = {
  conversationId: string;
  provider: string;
  kind: string;
  displayName?: string;
  approverUserIds: string[];
};

export type AgentAdminResponse = {
  agent: Record<string, unknown>;
  dmAccess: {
    entries: AgentDmAccessEntry[];
  };
  boundConversations: AgentAdminBoundConversation[];
};

export type AgentDmAccessResponse = {
  agentId: string;
  dmAccess: {
    entries: AgentDmAccessEntry[];
  };
  updatedAt: string;
};

export function createAgentAdminClient(transport: TransportLike) {
  return {
    getAdmin: (agentId: string) =>
      transport.request<AgentAdminResponse>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/admin`,
      }),
    setDmAccess: (agentId: string, entries: AgentDmAccessEntry[]) =>
      transport.request<AgentDmAccessResponse>({
        method: 'PUT',
        path: `/v1/agents/${encodeURIComponent(agentId)}/dm-access`,
        body: { entries },
      }),
  };
}
