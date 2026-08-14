import type {
  AgentCreationDraft,
  AgentCreationPreflightResponse,
  CreateAgentCreationDraftRequest,
  UpdateAgentCreationDraftRequest,
} from '@gantry/contracts';

type TransportLike = {
  request<T>(options: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T>;
};

export function createAgentCreationDraftsClient(transport: TransportLike) {
  return {
    list: () =>
      transport.request<{ drafts: AgentCreationDraft[] }>({
        method: 'GET',
        path: '/v1/agent-creation-drafts',
      }),
    get: (id: string) =>
      transport.request<AgentCreationDraft>({
        method: 'GET',
        path: `/v1/agent-creation-drafts/${encodeURIComponent(id)}`,
      }),
    create: (body: CreateAgentCreationDraftRequest) =>
      transport.request<AgentCreationDraft>({
        method: 'POST',
        path: '/v1/agent-creation-drafts',
        body,
      }),
    update: (id: string, body: UpdateAgentCreationDraftRequest) =>
      transport.request<AgentCreationDraft>({
        method: 'PUT',
        path: `/v1/agent-creation-drafts/${encodeURIComponent(id)}`,
        body,
      }),
    delete: (id: string) =>
      transport.request<{ deleted: true }>({
        method: 'DELETE',
        path: `/v1/agent-creation-drafts/${encodeURIComponent(id)}`,
      }),
    preflight: (id: string) =>
      transport.request<AgentCreationPreflightResponse>({
        method: 'POST',
        path: `/v1/agent-creation-drafts/${encodeURIComponent(id)}/preflight`,
      }),
    createOrResume: (id: string) =>
      transport.request<AgentCreationDraft>({
        method: 'POST',
        path: `/v1/agent-creation-drafts/${encodeURIComponent(id)}/create`,
      }),
  };
}
