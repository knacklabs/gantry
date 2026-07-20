import type {
  AgentProfileFileContentResponse,
  AgentProfileFileKind,
  AgentProfileFilesResponse,
  GetAgentDelegatesResponse,
  ReplaceAgentDelegatesRequest,
  ReplaceAgentDelegatesResponse,
  SetAgentProfileFileRequest,
  SetAgentProfileFileResponse,
} from './openapi-types.js';

export type {
  AgentProfileFileContentResponse,
  AgentProfileFileKind,
  AgentProfileFilesResponse,
  AgentProfileFileSummary,
} from './openapi-types.js';

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

export function createAgentAdminClient(transport: TransportLike) {
  return {
    getAdmin: (agentId: string) =>
      transport.request<AgentAdminResponse>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/admin`,
      }),
    getDelegates: (agentId: string) =>
      transport.request<GetAgentDelegatesResponse>({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/delegates`,
      }),
    replaceDelegates: (agentId: string, body: ReplaceAgentDelegatesRequest) =>
      transport.request<ReplaceAgentDelegatesResponse>({
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
      body: SetAgentProfileFileRequest,
    ) =>
      transport.request<SetAgentProfileFileResponse>({
        method: 'PUT',
        path: `/v1/agents/${encodeURIComponent(agentId)}/profile-files/${kind}`,
        body,
      }),
  };
}
