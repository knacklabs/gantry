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
    mode: 'trigger' | 'drop';
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

export function createAgentAdminClient(transport: TransportLike) {
  return {
    getAdmin: (agentId: string) =>
      transport.request<AgentAdminResponse>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/admin`,
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
  };
}
