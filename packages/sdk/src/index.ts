import type {
  ConversationDiscoveryInput,
  ConversationInstallInput,
  ProviderAccountInput,
  ProviderAccountPatch,
} from './provider-types.js';
import { createAgentAdminClient } from './agents.js';
import { createAgentSkillsClient, createSkillsClient } from './skills.js';
import { createSettingsClient } from './settings.js';
import type {
  ClientOptions,
  MemoryContext,
  MemoryPatchInput,
  MemorySaveInput,
  MemorySearchInput,
  RequestOptions,
  RuntimeEventListResponse,
  RuntimeEventQuery,
  RuntimeEventStreamOptions,
  TraceRequestOptions,
} from './types.js';
import { runtimeEventQuery } from './runtime-event-query.js';
import type * as OpenApi from './openapi-types.js';
import { createIngressesClient } from './ingresses.js';
import { querySuffix } from './query-string.js';
export type { RuntimeSettingsResponse } from './settings.js';
import * as mcpServerClients from './mcp-servers.js';
import { jobListQuery } from './job-list-query.js';
import { createModelsClient } from './models.js';
import { createLlmClient } from './llm.js';
import { Transport } from './transport.js';
import type { ReviewedMcpCapabilityManifest } from '@gantry/contracts';
export type { GantryError } from './transport.js';
import type {
  CreateJobInput,
  CreateJobResponse,
  JobRecord,
  JobTriggerWaitResult,
  ListJobEventsInput,
  ListJobsInput,
  UpdateJobInput,
} from './job-model-types.js';
export type {
  AgentAdminBoundConversation,
  AgentAdminResponse,
  AgentAccessDocument,
  AgentAccessSelection,
} from './agents.js';
export type {
  CreateJobInput,
  CreateJobResponse,
  JobEventRecord,
  JobHealth,
  JobHealthState,
  JobAgentTask,
  JobKind,
  JobRecord,
  JobSetup,
  JobStatus,
  JobTriggerWaitResult,
  ListJobEventsInput,
  ListJobsInput,
  ModelRecord,
  ModelDefaultsPatchRequest,
  ModelDefaultsResponse,
  ModelPreviewRequest,
  ModelPreviewResponse,
  UpdateJobInput,
} from './job-model-types.js';
export type * from './openapi-types.js';

export class GantryClient {
  private readonly transport: Transport;
  private readonly request = <T>(options: RequestOptions) =>
    this.transport.request<T>(options);
  readonly ingresses: ReturnType<typeof createIngressesClient>;
  readonly llm: ReturnType<typeof createLlmClient>;
  readonly models: ReturnType<typeof createModelsClient>;

  constructor(options: ClientOptions) {
    this.transport = new Transport(options);
    this.ingresses = createIngressesClient(this.transport);
    this.llm = createLlmClient(this.transport);
    this.models = createModelsClient(this.transport);
  }

  health() {
    return this.transport.request<OpenApi.HealthResponse>({
      method: 'GET',
      path: '/v1/health',
    });
  }

  doctor() {
    return this.transport.request<OpenApi.DoctorResponse>({
      method: 'GET',
      path: '/v1/doctor',
    });
  }

  readonly settings = createSettingsClient({ request: this.request });

  readonly capabilities = {
    list: () =>
      this.transport.request<OpenApi.ListCapabilitiesResponse>({
        method: 'GET',
        path: '/v1/capabilities',
      }),
    get: (capabilityId: string) =>
      this.transport.request<OpenApi.GetCapabilityResponse>({
        method: 'GET',
        path: `/v1/capabilities/${encodeURIComponent(capabilityId)}`,
      }),
    register: (capabilityId: string, input: ReviewedMcpCapabilityManifest) =>
      this.transport.request<OpenApi.PutCapabilityResponse>({
        method: 'PUT',
        path: `/v1/capabilities/${encodeURIComponent(capabilityId)}`,
        body: input,
      }),
  };

  readonly sessions = {
    ensure: (input: OpenApi.EnsureSessionRequest) =>
      this.transport.request<OpenApi.EnsureSessionResponse>({
        method: 'POST',
        path: '/v1/sessions/ensure',
        body: input,
      }),
    sendMessage: ({ sessionId, ...body }: OpenApi.SendSessionMessageInput) =>
      this.transport.request<OpenApi.SendSessionMessageResponse>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        body,
      }),
    resolveInteraction: (
      sessionId: string,
      interactionId: string,
      body: OpenApi.ResolveSessionInteractionRequest,
    ) =>
      this.transport.request<OpenApi.SessionInteractionSettlementResponse>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/resolve`,
        body,
      }),
    rejectInteraction: (
      sessionId: string,
      interactionId: string,
      body: OpenApi.RejectSessionInteractionRequest,
    ) =>
      this.transport.request<OpenApi.SessionInteractionSettlementResponse>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/reject`,
        body,
      }),
    cancelTurn: (
      sessionId: string,
      body: OpenApi.CancelSessionTurnRequest = {},
    ) =>
      this.transport.request<OpenApi.CancelSessionTurnResponse>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/turns/current/cancel`,
        body,
      }),
    archive: (sessionId: string) =>
      this.transport.request<OpenApi.ArchiveSessionResponse>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/archive`,
      }),
    listEvents: (
      sessionId: string,
      afterEventId?: OpenApi.ListSessionEventsQuery['afterEventId'],
    ) =>
      this.transport.request<OpenApi.ListSessionEventsResponse>({
        method: 'GET',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/events${afterEventId ? `?afterEventId=${afterEventId}` : ''}`,
      }),
    stream: (
      sessionId: string,
      input: OpenApi.SessionEventStreamOptions = {},
    ) =>
      this.transport.stream(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events${input.afterEventId ? `?afterEventId=${input.afterEventId}` : ''}`,
        input.signal,
      ),
    wait: (sessionId: string, input: OpenApi.WaitForSessionEventQuery = {}) =>
      this.transport.request<OpenApi.WaitForSessionEventResponse>({
        method: 'GET',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/wait?afterEventId=${input.afterEventId || 0}&timeoutMs=${input.timeoutMs || 60_000}`,
      }),
  };

  readonly runtimeEvents = {
    list: (input: RuntimeEventQuery = {}) =>
      this.transport.request<RuntimeEventListResponse>({
        method: 'GET',
        path: `/v1/runtime-events${runtimeEventQuery(input)}`,
      }),
    stream: (input: RuntimeEventStreamOptions = {}) =>
      this.transport.stream(
        `/v1/runtime-events${runtimeEventQuery(input)}`,
        input.signal,
      ),
  };

  readonly jobs = {
    create: (input: CreateJobInput, options?: TraceRequestOptions) =>
      this.transport.request<CreateJobResponse>({
        method: 'POST',
        path: '/v1/jobs',
        body: input,
        ...(options?.traceparent ? { traceparent: options.traceparent } : {}),
      }),
    list: (input?: ListJobsInput) =>
      this.transport.request<OpenApi.ListJobsResponse>({
        method: 'GET',
        path: `/v1/jobs${jobListQuery(input)}`,
      }),
    get: (jobId: string) =>
      this.transport.request<JobRecord>({
        method: 'GET',
        path: `/v1/jobs/${encodeURIComponent(jobId)}`,
      }),
    update: (jobId: string, patch: UpdateJobInput) =>
      this.transport.request<JobRecord>({
        method: 'PATCH',
        path: `/v1/jobs/${encodeURIComponent(jobId)}`,
        body: patch,
      }),
    events: (jobId: string, input: ListJobEventsInput = {}) =>
      this.transport.request<OpenApi.ListJobEventsResponse>({
        method: 'GET',
        path: `/v1/jobs/${encodeURIComponent(jobId)}/events${querySuffix({
          run: input.runId,
          eventType: input.eventType,
          sinceId: input.sinceId,
          since: input.since,
          limit: input.limit,
        })}`,
      }),
    delete: (jobId: string) =>
      this.transport.request<OpenApi.DeleteJobResponse>({
        method: 'DELETE',
        path: `/v1/jobs/${encodeURIComponent(jobId)}`,
      }),
    pause: (jobId: string) =>
      this.transport.request<OpenApi.PauseJobResponse>({
        method: 'POST',
        path: `/v1/jobs/${encodeURIComponent(jobId)}/pause`,
      }),
    resume: (jobId: string) =>
      this.transport.request<OpenApi.ResumeJobResponse>({
        method: 'POST',
        path: `/v1/jobs/${encodeURIComponent(jobId)}/resume`,
      }),
    trigger: (jobId: string) =>
      this.transport.request<OpenApi.TriggerJobResponse>({
        method: 'POST',
        path: `/v1/jobs/${encodeURIComponent(jobId)}/trigger`,
      }),
    wait: (triggerId: string, timeoutMs?: number) =>
      this.transport.request<JobTriggerWaitResult>({
        method: 'GET',
        path: `/v1/triggers/${encodeURIComponent(triggerId)}/wait?timeoutMs=${timeoutMs || 60_000}`,
      }),
  };

  readonly runs = {
    list: (jobId?: OpenApi.ListRunsQuery['jobId']) =>
      this.transport.request<OpenApi.ListRunsResponse>({
        method: 'GET',
        path: `/v1/runs${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''}`,
      }),
    get: (runId: string) =>
      this.transport.request<OpenApi.GetRunResponse>({
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(runId)}`,
      }),
  };

  readonly usage = {
    query: (input: OpenApi.QueryUsageQuery) =>
      this.transport.request<OpenApi.QueryUsageResponse>({
        method: 'GET',
        path: `/v1/usage${querySuffix(input)}`,
      }),
  };

  readonly skills = createSkillsClient({ request: this.request });
  readonly mcpServers = mcpServerClients.createMcpServersClient({
    request: this.request,
  });

  readonly providers = {
    list: () =>
      this.transport.request<OpenApi.ListProvidersResponse>({
        method: 'GET',
        path: '/v1/providers',
      }),
  };

  readonly providerAccounts = {
    create: (input: ProviderAccountInput) =>
      this.transport.request<OpenApi.CreateProviderAccountResponse>({
        method: 'POST',
        path: '/v1/provider-accounts',
        body: input,
      }),
    list: () =>
      this.transport.request<OpenApi.ListProviderAccountsResponse>({
        method: 'GET',
        path: '/v1/provider-accounts',
      }),
    get: (providerAccountId: string) =>
      this.transport.request<OpenApi.GetProviderAccountResponse>({
        method: 'GET',
        path: `/v1/provider-accounts/${encodeURIComponent(providerAccountId)}`,
      }),
    update: (providerAccountId: string, patch: ProviderAccountPatch) =>
      this.transport.request<OpenApi.UpdateProviderAccountResponse>({
        method: 'PATCH',
        path: `/v1/provider-accounts/${encodeURIComponent(providerAccountId)}`,
        body: patch,
      }),
    delete: (providerAccountId: string) =>
      this.transport.request<OpenApi.DisableProviderAccountResponse>({
        method: 'DELETE',
        path: `/v1/provider-accounts/${encodeURIComponent(providerAccountId)}`,
      }),
    discoverConversations: (
      providerAccountId: string,
      input: ConversationDiscoveryInput = {},
    ) =>
      this.transport.request<OpenApi.DiscoverProviderConversationsResponse>({
        method: 'POST',
        path: `/v1/provider-accounts/${encodeURIComponent(providerAccountId)}/discover-conversations`,
        body: input,
      }),
  };

  readonly conversations = {
    list: (input: OpenApi.ListConversationsQuery = {}) =>
      this.transport.request<OpenApi.ListConversationsResponse>({
        method: 'GET',
        path: `/v1/conversations${querySuffix(input)}`,
      }),
    get: (conversationId: string) =>
      this.transport.request<OpenApi.GetConversationResponse>({
        method: 'GET',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}`,
      }),
    getApprovers: (conversationId: string) =>
      this.transport.request<OpenApi.ListConversationApproversResponse>({
        method: 'GET',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}/approvers`,
      }),
    setApprovers: (
      conversationId: string,
      userIds: OpenApi.ReplaceConversationApproversRequest['userIds'],
    ) =>
      this.transport.request<OpenApi.ReplaceConversationApproversResponse>({
        method: 'PUT',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}/approvers`,
        body: { userIds },
      }),
    messages: (
      conversationId: string,
      input: OpenApi.ListConversationMessagesQuery = {},
    ) =>
      this.transport.request<OpenApi.ListConversationMessagesResponse>({
        method: 'GET',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}/messages${querySuffix(input)}`,
      }),
    send: (
      conversationId: string,
      input: OpenApi.SendConversationMessageRequest,
    ) =>
      this.transport.request<OpenApi.SendConversationMessageResponse>({
        method: 'POST',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
        body: input,
      }),
  };

  readonly agents = {
    ...createAgentAdminClient({ request: this.request }),
    skills: createAgentSkillsClient({ request: this.request }),
    mcpServers: mcpServerClients.createAgentMcpServersClient({
      request: this.request,
    }),
    conversationInstalls: {
      list: (agentId: string) =>
        this.transport.request<OpenApi.ListConversationInstallsResponse>({
          method: 'GET',
          path: `/v1/agents/${encodeURIComponent(agentId)}/conversation-installs`,
        }),
      enable: (
        agentId: string,
        conversationId: string,
        input: ConversationInstallInput = {},
      ) =>
        this.transport.request<OpenApi.EnableConversationInstallResponse>({
          method: 'PUT',
          path: `/v1/agents/${encodeURIComponent(agentId)}/conversation-installs/${encodeURIComponent(conversationId)}`,
          body: input,
        }),
      update: (
        agentId: string,
        conversationId: string,
        patch: ConversationInstallInput,
      ) =>
        this.transport.request<OpenApi.UpdateConversationInstallResponse>({
          method: 'PATCH',
          path: `/v1/agents/${encodeURIComponent(agentId)}/conversation-installs/${encodeURIComponent(conversationId)}`,
          body: patch,
        }),
      disable: (
        agentId: string,
        conversationId: string,
        input: OpenApi.DisableConversationInstallQuery = {},
      ) =>
        this.transport.request<OpenApi.DisableConversationInstallResponse>({
          method: 'DELETE',
          path: `/v1/agents/${encodeURIComponent(agentId)}/conversation-installs/${encodeURIComponent(conversationId)}${querySuffix(input)}`,
        }),
    },
  };

  readonly webhooks = {
    register: (input: OpenApi.CreateWebhookRequest) =>
      this.transport.request<OpenApi.CreateWebhookResponse>({
        method: 'POST',
        path: '/v1/webhooks',
        body: input,
      }),
    list: () =>
      this.transport.request<OpenApi.ListWebhooksResponse>({
        method: 'GET',
        path: '/v1/webhooks',
      }),
    update: (webhookId: string, patch: OpenApi.UpdateWebhookRequest) =>
      this.transport.request<OpenApi.UpdateWebhookResponse>({
        method: 'PATCH',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}`,
        body: patch,
      }),
    delete: (webhookId: string) =>
      this.transport.request<OpenApi.DeleteWebhookResponse>({
        method: 'DELETE',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}`,
      }),
    test: (webhookId: string) =>
      this.transport.request<OpenApi.TestWebhookResponse>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}/test`,
      }),
    replayDeadLetter: (webhookId: string) =>
      this.transport.request<OpenApi.ReplayWebhookDeadLettersResponse>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}/replay-dead-letter`,
      }),
    purgeDeadLetter: (webhookId: string) =>
      this.transport.request<OpenApi.PurgeWebhookDeadLettersResponse>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}/purge-dead-letter`,
      }),
  };

  readonly memory = {
    save: (input: MemorySaveInput) =>
      this.transport.request<OpenApi.CreateMemoryResponse>({
        method: 'POST',
        path: '/v1/memory',
        body: input,
      }),
    search: (input: MemorySearchInput) =>
      this.transport.request<OpenApi.SearchMemoryResponse>({
        method: 'POST',
        path: '/v1/memory/search',
        body: input,
      }),
    list: (input: MemorySearchInput = {}) =>
      this.transport.request<OpenApi.ListMemoryResponse>({
        method: 'GET',
        path: `/v1/memory${querySuffix(input)}`,
      }),
    patch: (memoryId: string, patch: MemoryPatchInput) =>
      this.transport.request<OpenApi.PatchMemoryResponse>({
        method: 'PATCH',
        path: `/v1/memory/${encodeURIComponent(memoryId)}`,
        body: patch,
      }),
    delete: (memoryId: string, input: MemoryContext = {}) =>
      this.transport.request<OpenApi.DeleteMemoryResponse>({
        method: 'DELETE',
        path: `/v1/memory/${encodeURIComponent(memoryId)}${querySuffix(input)}`,
      }),
    dreaming: {
      trigger: (input: OpenApi.TriggerMemoryDreamingRequest = {}) =>
        this.transport.request<OpenApi.TriggerMemoryDreamingResponse>({
          method: 'POST',
          path: '/v1/memory/dreaming/trigger',
          body: input,
        }),
      status: (input: MemoryContext = {}) =>
        this.transport.request<OpenApi.MemoryDreamingStatusResponse>({
          method: 'GET',
          path: `/v1/memory/dreaming/status${querySuffix(input)}`,
        }),
    },
  };
}
export const createClient = (options: ClientOptions) =>
  new GantryClient(options);

export type {
  ConversationMessageIngressTarget,
  ExternalIngressInvokeBody,
  ExternalIngressTarget,
  JobTemplateIngressTarget,
  JobTriggerIngressTarget,
  SessionMessageIngressTarget,
} from './ingresses.js';
export type {
  RuntimeEventEnvelope,
  RuntimeEventListResponse,
  RuntimeEventQuery,
  RuntimeEventStreamOptions,
} from './types.js';
export { conversationMessageTarget } from './ingresses.js';
export {
  buildIngressSignaturePayload,
  signIngressRequest,
  signIngressSignaturePayload,
  verifyIngressSignature,
} from './ingress-signature.js';
export { verifyWebhookSignature } from './webhook-signature.js';
