import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type {
  ConversationDiscoveryInput,
  ConversationInstallInput,
  ProviderAccountInput,
  ProviderAccountPatch,
} from './provider-types.js';
import { createAgentAdminClient } from './agents.js';
import { createAgentSkillsClient, createSkillsClient } from './skills.js';
import { createSettingsClient } from './settings.js';
import { createSessionsClient } from './sessions.js';
import type {
  ClientOptions,
  MemoryContext,
  MemoryPatchInput,
  MemoryReviewDecisionInput,
  MemoryReviewListInput,
  MemoryReviewSubject,
  MemorySaveInput,
  MemorySearchInput,
  LlmRequestOptions,
  RequestOptions,
  RuntimeEventListResponse,
  RuntimeEventQuery,
  RuntimeEventStreamOptions,
  SseEvent,
  TraceRequestOptions,
  TransportResponse,
} from './types.js';
import { runtimeEventQuery } from './runtime-event-query.js';
import type * as OpenApi from './openapi-types.js';
import { parseSessionSseEvent } from './session-events.js';
export {
  SessionTypingTracker,
  type SessionTypingTrackerSeed,
} from './session-events.js';
import { createIngressesClient } from './ingresses.js';
import { querySuffix } from './query-string.js';
import { createIdentityClient, createPeopleClient } from './people.js';
export type { RuntimeSettingsResponse } from './settings.js';
import * as mcpServerClients from './mcp-servers.js';
import { createModelsClient } from './models.js';
import type { ReviewedMcpCapabilityManifest } from '@gantry/contracts';
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
  AgentAccessDocument,
  AgentAccessSelection,
  AgentAdminBoundConversation,
  AgentAdminResponse,
} from './agents.js';
export type * from './job-model-types.js';
export type * from './openapi-types.js';
export type * from './people.js';

export type ResponseMode = 'sse' | 'webhook' | 'both' | 'none';
export type MemorySubjectType = 'user' | 'group' | 'channel' | 'common';
export type DreamPhase = 'light' | 'rem' | 'deep' | 'all';
export type ProcessRole = 'all' | 'control' | 'live-worker' | 'job-worker';

export interface HealthResponse {
  status: string;
  processRole: ProcessRole;
  transport:
    | { kind: 'tcp'; port: number }
    | { kind: 'unix'; socketPath: string };
  features: {
    sessions: boolean;
    jobs: boolean;
    events: boolean;
    webhooks: boolean;
  };
}

export interface GantryError extends Error {
  code: string;
  details?: Record<string, unknown> | null;
  requestId?: string;
  retryable?: boolean;
  restartRequired?: boolean;
  nextAction?: string;
}
function toError(input: unknown): GantryError {
  const fallback = new Error('Gantry request failed') as GantryError;
  fallback.code = 'UNKNOWN_ERROR';
  const envelope = Array.isArray(input) && input.length > 0 ? input[0] : input;
  if (
    envelope &&
    typeof envelope === 'object' &&
    'error' in envelope &&
    envelope.error &&
    typeof envelope.error === 'object'
  ) {
    const error = envelope.error as Record<string, unknown>;
    const next = new Error(
      String(error.message || 'Gantry request failed'),
    ) as GantryError;
    next.code = String(error.status || error.code || 'UNKNOWN_ERROR');
    next.details =
      error.details && typeof error.details === 'object'
        ? (error.details as Record<string, unknown>)
        : null;
    next.requestId =
      typeof error.requestId === 'string' ? error.requestId : undefined;
    next.retryable =
      typeof error.retryable === 'boolean' ? error.retryable : undefined;
    next.restartRequired =
      typeof error.restartRequired === 'boolean'
        ? error.restartRequired
        : undefined;
    next.nextAction =
      typeof error.nextAction === 'string' ? error.nextAction : undefined;
    return next;
  }
  return fallback;
}

function parseJsonBody(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(
      'Gantry returned a non-JSON response',
    ) as GantryError;
    error.code = 'INVALID_RESPONSE';
    throw error;
  }
}

class Transport {
  private readonly apiKey: string;
  private readonly baseUrl: URL;
  private readonly socketPath?: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = new URL(options.baseUrl || 'http://127.0.0.1:3939');
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  request<T>(options: RequestOptions): Promise<T> {
    return this.requestWithMetadata<T>(options).then(({ body }) => body);
  }

  requestWithMetadata<T>(
    options: RequestOptions,
  ): Promise<TransportResponse<T>> {
    const url = new URL(options.path, this.baseUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const body =
      options.body === undefined
        ? undefined
        : options.body instanceof Uint8Array
          ? options.body
          : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: options.accept || 'application/json',
    };
    if (options.traceparent) headers.traceparent = options.traceparent;
    if (body) {
      headers['content-type'] =
        options.contentType ||
        (options.body instanceof Uint8Array
          ? 'application/octet-stream'
          : 'application/json');
    }
    return new Promise<TransportResponse<T>>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: this.socketPath ? undefined : url.hostname,
          port: this.socketPath ? undefined : url.port,
          path: `${url.pathname}${url.search}`,
          socketPath: this.socketPath,
          method: options.method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = {};
            try {
              parsed = parseJsonBody(raw);
            } catch (error) {
              reject(error);
              return;
            }
            if ((res.statusCode || 500) >= 400) {
              reject(toError(parsed));
              return;
            }
            const responseHeaders: Record<string, string | undefined> = {};
            for (const [name, value] of Object.entries(res.headers)) {
              responseHeaders[name.toLowerCase()] = Array.isArray(value)
                ? value.join(', ')
                : value;
            }
            resolve({ body: parsed as T, headers: responseHeaders });
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error('Gantry request timed out'));
      });
      req.on('error', reject);
      if (options.signal) {
        options.signal.addEventListener(
          'abort',
          () => req.destroy(new Error('Gantry request aborted')),
          { once: true },
        );
      }
      if (body) req.write(body);
      req.end();
    });
  }

  async *stream(
    pathname: string,
    signal?: AbortSignal,
  ): AsyncIterable<SseEvent> {
    const url = new URL(pathname, this.baseUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: url.protocol,
      hostname: this.socketPath ? undefined : url.hostname,
      port: this.socketPath ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      socketPath: this.socketPath,
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'text/event-stream',
      },
    });
    if (signal) {
      signal.addEventListener(
        'abort',
        () => req.destroy(new Error('Gantry stream aborted')),
        { once: true },
      );
    }
    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        req.on('response', resolve);
        req.on('error', reject);
        req.end();
      },
    );
    if ((response.statusCode || 500) >= 400) {
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        chunks.push(Buffer.from(chunk));
      }
      throw toError(parseJsonBody(Buffer.concat(chunks).toString('utf8')));
    }
    let buffer = '';
    for await (const chunk of response) {
      buffer += chunk.toString();
      while (true) {
        const delimiter = buffer.indexOf('\n\n');
        if (delimiter < 0) break;
        const block = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        const lines = block.split('\n');
        const idLine = lines.find((line) => line.startsWith('id: '));
        const eventLine = lines.find((line) => line.startsWith('event: '));
        const dataLine = lines.find((line) => line.startsWith('data: '));
        if (!idLine || !eventLine || !dataLine) continue;
        yield parseSessionSseEvent({
          eventId: Number(idLine.slice(4).trim()),
          eventType: eventLine.slice(7).trim(),
          data: JSON.parse(dataLine.slice(6)),
        });
      }
    }
  }
}

export class GantryClient {
  private readonly transport: Transport;
  private readonly request = <T>(options: RequestOptions) =>
    this.transport.request<T>(options);
  readonly ingresses: ReturnType<typeof createIngressesClient>;
  readonly models: ReturnType<typeof createModelsClient>;
  readonly identity: ReturnType<typeof createIdentityClient>;
  readonly people: ReturnType<typeof createPeopleClient>;
  readonly llm: ReturnType<GantryClient['createLlmClient']>;

  constructor(options: ClientOptions) {
    this.transport = new Transport(options);
    this.ingresses = createIngressesClient(this.transport);
    this.models = createModelsClient(this.transport);
    this.identity = createIdentityClient(this.request);
    this.people = createPeopleClient(this.request);
    this.llm = this.createLlmClient();
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

  private createLlmClient() {
    return {
      chatCompletions: (
        input: OpenApi.LlmChatCompletionsRequest,
        options?: LlmRequestOptions,
      ) =>
        this.transport
          .requestWithMetadata<OpenApi.LlmChatCompletionsResponse>({
            method: 'POST',
            path: '/llm/v1/chat/completions',
            body: input,
            ...(options?.traceparent
              ? { traceparent: options.traceparent }
              : {}),
          })
          .then(({ body, headers }) => ({
            response: body,
            gantryRequestId: requiredHeader(headers, 'x-gantry-request-id'),
            modelAlias: requiredHeader(headers, 'x-gantry-model-alias'),
            modelRoute: requiredHeader(headers, 'x-gantry-model-route'),
            provider: requiredHeader(headers, 'x-gantry-provider'),
          })),
    };
  }

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
      this.transport.request<unknown>({
        method: 'PUT',
        path: `/v1/capabilities/${encodeURIComponent(capabilityId)}`,
        body: input,
      }),
  };

  readonly sessions = createSessionsClient({
    request: this.request,
    stream: (pathname, signal) => this.transport.stream(pathname, signal),
  });

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
        path: `/v1/jobs${querySuffix({
          agentId: input?.agentId || undefined,
          workspaceKey: input?.workspaceKey || undefined,
          conversationJid: input?.conversationJid || undefined,
          kind: input?.kind || undefined,
          limit: input?.limit,
          status: Array.isArray(input?.status)
            ? input.status
            : input?.status
              ? [input.status]
              : undefined,
        })}`,
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

  readonly capabilityTasks = {
    complete: (
      taskId: string,
      input: {
        completionToken: string;
        completionId: string;
        resultRef: string;
        summary: string;
        result: Record<string, unknown>;
      },
    ) =>
      this.transport.request<{
        outcome: 'completed' | 'idempotent' | 'late_ignored';
        taskId: string;
        status: string;
        resumed: boolean;
      }>({
        method: 'POST',
        path: `/v1/capability-tasks/${encodeURIComponent(taskId)}/complete`,
        body: input,
      }),
    cancel: (
      taskId: string,
      input: {
        completionToken: string;
        cancellationId: string;
        reason: string;
      },
    ) =>
      this.transport.request<{
        outcome: 'completed' | 'idempotent' | 'late_ignored';
        taskId: string;
        status: string;
        resumed: boolean;
      }>({
        method: 'POST',
        path: `/v1/capability-tasks/${encodeURIComponent(taskId)}/cancel`,
        body: input,
      }),
    recover: (input: {
      idempotencyKey: string;
      capabilityId: string;
      operation: string;
    }) =>
      this.transport.request<{
        taskId: string;
        completionToken: string;
        status: 'waiting_external';
        created: false;
      }>({
        method: 'POST',
        path: '/v1/capability-tasks/recover',
        body: input,
      }),
  };

  readonly usage = {
    query: (input: OpenApi.QueryUsageQuery) =>
      this.transport.request<OpenApi.QueryUsageResponse>({
        method: 'GET',
        path: `/v1/usage${querySuffix(input)}`,
      }),
  };

  readonly observer = {
    status: (input: OpenApi.GetObserverStatusQuery = {}) =>
      this.transport.request<OpenApi.ObserverStatusResponse>({
        method: 'GET',
        path: `/v1/observer/status${querySuffix(input)}`,
      }),
    insights: (input: OpenApi.ListObserverInsightsQuery = {}) =>
      this.transport.request<OpenApi.ObserverInsightListResponse>({
        method: 'GET',
        path: `/v1/observer/insights${querySuffix(input)}`,
      }),
    preview: (input: OpenApi.PreviewObserverDigestQuery = {}) =>
      this.transport.request<OpenApi.ObserverDigestPreviewResponse>({
        method: 'POST',
        path: `/v1/observer/preview${querySuffix(input)}`,
      }),
    deliveries: (input: OpenApi.ListObserverDeliveriesQuery = {}) =>
      this.transport.request<OpenApi.ObserverDigestDeliveryListResponse>({
        method: 'GET',
        path: `/v1/observer/deliveries${querySuffix(input)}`,
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
    reviews: {
      list: (input: MemoryReviewListInput) =>
        this.transport.request<OpenApi.ListMemoryReviewsResponse>({
          method: 'GET',
          path: `/v1/memory/reviews${querySuffix(input)}`,
        }),
      get: (reviewId: string, input: MemoryReviewSubject) =>
        this.transport.request<OpenApi.GetMemoryReviewResponse>({
          method: 'GET',
          path: `/v1/memory/reviews/${encodeURIComponent(reviewId)}${querySuffix(input)}`,
        }),
      decide: (reviewId: string, input: MemoryReviewDecisionInput) => {
        const { decision, editedValue, reason, ...subject } = input;
        return this.transport.request<OpenApi.DecideMemoryReviewResponse>({
          method: 'POST',
          // The subject boundary rides on the query; the body carries only the
          // decision so reviewer identity stays key-derived server-side.
          path: `/v1/memory/reviews/${encodeURIComponent(reviewId)}/decision${querySuffix(subject)}`,
          body: {
            decision,
            ...(editedValue === undefined ? {} : { editedValue }),
            ...(reason === undefined ? {} : { reason }),
          },
        });
      },
    },
  };
}
export const createClient = (options: ClientOptions) =>
  new GantryClient(options);

function requiredHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = headers[name]?.trim();
  if (value) return value;
  const error = new Error(`Gantry response is missing ${name}`) as GantryError;
  error.code = 'INVALID_RESPONSE';
  throw error;
}

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
