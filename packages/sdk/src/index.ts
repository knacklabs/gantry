import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type {
  AgentConversationBindingInput,
  ConversationDiscoveryInput,
  ProviderConnectionInput,
  ProviderConnectionPatch,
} from './provider-types.js';
import { createAgentAdminClient } from './agents.js';
import { createAgentSkillsClient, createSkillDraftsClient } from './skills.js';
import { createSettingsClient } from './settings.js';
import type {
  ClientOptions,
  MemoryContext,
  MemoryPatchInput,
  MemorySaveInput,
  MemorySearchInput,
  RequestOptions,
  SseEvent,
} from './types.js';
import { createIngressesClient } from './ingresses.js';
export type { RuntimeSettingsResponse } from './settings.js';
import * as mcpServerClients from './mcp-servers.js';
import { jobListQuery } from './job-list-query.js';
import type {
  CreateJobInput,
  CreateJobResponse,
  JobRecord,
  JobTriggerWaitResult,
  ListJobsInput,
  ModelRecord,
  UpdateJobInput,
} from './job-model-types.js';
export type {
  AgentAdminBoundConversation,
  AgentAdminResponse,
  AgentDmAccessEntry,
  AgentDmAccessResponse,
} from './agents.js';
export type {
  CreateJobInput,
  CreateJobResponse,
  JobExecutionMode,
  JobKind,
  JobRecord,
  JobStatus,
  JobTriggerWaitResult,
  ListJobsInput,
  ModelRecord,
  UpdateJobInput,
} from './job-model-types.js';
export type ResponseMode = 'sse' | 'webhook' | 'both' | 'none';
export type MemorySubjectType = 'user' | 'group' | 'channel' | 'common';
export type DreamPhase = 'light' | 'rem' | 'deep' | 'all';

export interface MyClawError extends Error {
  code: string;
  details?: Record<string, unknown> | null;
  requestId?: string;
  retryable?: boolean;
  restartRequired?: boolean;
  nextAction?: string;
}
function toError(input: unknown): MyClawError {
  const fallback = new Error('MyClaw request failed') as MyClawError;
  fallback.code = 'UNKNOWN_ERROR';
  if (
    input &&
    typeof input === 'object' &&
    'error' in input &&
    input.error &&
    typeof input.error === 'object'
  ) {
    const error = input.error as Record<string, unknown>;
    const next = new Error(
      String(error.message || 'MyClaw request failed'),
    ) as MyClawError;
    next.code = String(error.code || 'UNKNOWN_ERROR');
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
      'MyClaw returned a non-JSON response',
    ) as MyClawError;
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
    if (body) {
      headers['content-type'] =
        options.contentType ||
        (options.body instanceof Uint8Array
          ? 'application/octet-stream'
          : 'application/json');
    }
    return new Promise<T>((resolve, reject) => {
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
            resolve(parsed as T);
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error('MyClaw request timed out'));
      });
      req.on('error', reject);
      if (options.signal) {
        options.signal.addEventListener(
          'abort',
          () => req.destroy(new Error('MyClaw request aborted')),
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
        () => req.destroy(new Error('MyClaw stream aborted')),
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
        yield {
          eventId: Number(idLine.slice(4).trim()),
          eventType: eventLine.slice(7).trim(),
          payload: JSON.parse(dataLine.slice(6)),
        };
      }
    }
  }
}

export class MyClawClient {
  private readonly transport: Transport;
  private readonly request = <T>(options: RequestOptions) =>
    this.transport.request<T>(options);
  readonly ingresses: ReturnType<typeof createIngressesClient>;

  constructor(options: ClientOptions) {
    this.transport = new Transport(options);
    this.ingresses = createIngressesClient(this.transport);
  }

  health() {
    return this.transport.request<{ status: string }>({
      method: 'GET',
      path: '/v1/health',
    });
  }

  doctor() {
    return this.transport.request<{ status: string; checks: unknown[] }>({
      method: 'GET',
      path: '/v1/doctor',
    });
  }

  readonly settings = createSettingsClient({ request: this.request });

  readonly sessions = {
    ensure: (input: {
      appId?: string;
      conversationId: string;
      title?: string;
      responseMode?: ResponseMode;
      webhookId?: string;
    }) =>
      this.transport.request<{
        sessionId: string;
        appId: string;
        conversationId: string;
        chatJid: string;
      }>({
        method: 'POST',
        path: '/v1/sessions/ensure',
        body: input,
      }),
    sendMessage: (input: {
      sessionId: string;
      message: string;
      senderId?: string;
      senderName?: string;
      threadId?: string;
      correlationId?: string;
      responseMode?: ResponseMode;
      webhookId?: string;
    }) =>
      this.transport.request<{
        accepted: boolean;
        messageId: string;
        acceptedEventId: number;
      }>({
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        body: input,
      }),
    listEvents: (sessionId: string, afterEventId?: number) =>
      this.transport.request<{
        events: Array<{ eventId: number; eventType: string; payload: unknown }>;
      }>({
        method: 'GET',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/events${afterEventId ? `?afterEventId=${afterEventId}` : ''}`,
      }),
    stream: (
      sessionId: string,
      input: { afterEventId?: number; signal?: AbortSignal } = {},
    ) =>
      this.transport.stream(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events${input.afterEventId ? `?afterEventId=${input.afterEventId}` : ''}`,
        input.signal,
      ),
    wait: (
      sessionId: string,
      input: { afterEventId?: number; timeoutMs?: number } = {},
    ) =>
      this.transport.request<{
        eventId: number;
        eventType: string;
        payload: unknown;
        createdAt: string;
        afterEventId?: number;
      }>({
        method: 'GET',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/wait?afterEventId=${input.afterEventId || 0}&timeoutMs=${input.timeoutMs || 60_000}`,
      }),
  };

  readonly jobs = {
    create: (input: CreateJobInput) =>
      this.transport.request<CreateJobResponse>({
        method: 'POST',
        path: '/v1/jobs',
        body: input,
      }),
    list: (input?: ListJobsInput) =>
      this.transport.request<{ jobs: JobRecord[] }>({
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
    delete: (jobId: string) =>
      this.transport.request<{ deleted: boolean }>({
        method: 'DELETE',
        path: `/v1/jobs/${encodeURIComponent(jobId)}`,
      }),
    pause: (jobId: string) =>
      this.transport.request<{ paused: boolean }>({
        method: 'POST',
        path: `/v1/jobs/${encodeURIComponent(jobId)}/pause`,
      }),
    resume: (jobId: string) =>
      this.transport.request<{ resumed: boolean }>({
        method: 'POST',
        path: `/v1/jobs/${encodeURIComponent(jobId)}/resume`,
      }),
    trigger: (jobId: string) =>
      this.transport.request<{ triggerId: string }>({
        method: 'POST',
        path: `/v1/jobs/${encodeURIComponent(jobId)}/trigger`,
      }),
    wait: (triggerId: string, timeoutMs?: number) =>
      this.transport.request<JobTriggerWaitResult>({
        method: 'GET',
        path: `/v1/triggers/${encodeURIComponent(triggerId)}/wait?timeoutMs=${timeoutMs || 60_000}`,
      }),
  };

  readonly models = {
    list: () =>
      this.transport.request<{ models: ModelRecord[] }>({
        method: 'GET',
        path: '/v1/models',
      }),
  };

  readonly runs = {
    list: (jobId?: string) =>
      this.transport.request<{ runs: unknown[] }>({
        method: 'GET',
        path: `/v1/runs${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''}`,
      }),
    get: (runId: string) =>
      this.transport.request<Record<string, unknown>>({
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(runId)}`,
      }),
  };

  readonly skillDrafts = createSkillDraftsClient({ request: this.request });
  readonly mcpServers = mcpServerClients.createMcpServersClient({
    request: this.request,
  });

  readonly providers = {
    list: () =>
      this.transport.request<{ providers: unknown[] }>({
        method: 'GET',
        path: '/v1/providers',
      }),
  };

  readonly providerConnections = {
    create: (input: ProviderConnectionInput) =>
      this.transport.request<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/provider-connections',
        body: input,
      }),
    list: () =>
      this.transport.request<{ providerConnections: unknown[] }>({
        method: 'GET',
        path: '/v1/provider-connections',
      }),
    get: (providerConnectionId: string) =>
      this.transport.request<Record<string, unknown>>({
        method: 'GET',
        path: `/v1/provider-connections/${encodeURIComponent(providerConnectionId)}`,
      }),
    update: (providerConnectionId: string, patch: ProviderConnectionPatch) =>
      this.transport.request<Record<string, unknown>>({
        method: 'PATCH',
        path: `/v1/provider-connections/${encodeURIComponent(providerConnectionId)}`,
        body: patch,
      }),
    delete: (providerConnectionId: string) =>
      this.transport.request<{
        deleted: boolean;
        providerConnection?: unknown;
      }>({
        method: 'DELETE',
        path: `/v1/provider-connections/${encodeURIComponent(providerConnectionId)}`,
      }),
    discoverConversations: (
      providerConnectionId: string,
      input: ConversationDiscoveryInput = {},
    ) =>
      this.transport.request<{ conversations: unknown[] }>({
        method: 'POST',
        path: `/v1/provider-connections/${encodeURIComponent(providerConnectionId)}/discover-conversations`,
        body: input,
      }),
  };

  readonly conversations = {
    list: (input: { providerConnectionId?: string } = {}) => {
      const params = new URLSearchParams();
      if (input.providerConnectionId) {
        params.set('providerConnectionId', input.providerConnectionId);
      }
      return this.transport.request<{ conversations: unknown[] }>({
        method: 'GET',
        path: `/v1/conversations${params.toString() ? `?${params}` : ''}`,
      });
    },
    get: (conversationId: string) =>
      this.transport.request<Record<string, unknown>>({
        method: 'GET',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}`,
      }),
    getApprovers: (conversationId: string) =>
      this.transport.request<{ approvers: { userIds: string[] } }>({
        method: 'GET',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}/approvers`,
      }),
    setApprovers: (conversationId: string, userIds: string[]) =>
      this.transport.request<{ approvers: { userIds: string[] } }>({
        method: 'PUT',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}/approvers`,
        body: { userIds },
      }),
    messages: (
      conversationId: string,
      input: { threadId?: string; after?: string; limit?: number } = {},
    ) => {
      const params = new URLSearchParams();
      if (input.threadId) params.set('threadId', input.threadId);
      if (input.after) params.set('after', input.after);
      if (input.limit) params.set('limit', String(input.limit));
      return this.transport.request<{ messages: unknown[] }>({
        method: 'GET',
        path: `/v1/conversations/${encodeURIComponent(conversationId)}/messages${params.toString() ? `?${params}` : ''}`,
      });
    },
  };

  readonly agents = {
    ...createAgentAdminClient({ request: this.request }),
    skills: createAgentSkillsClient({ request: this.request }),
    mcpServers: mcpServerClients.createAgentMcpServersClient({
      request: this.request,
    }),
    conversationBindings: {
      list: (agentId: string) =>
        this.transport.request<{ bindings: unknown[] }>({
          method: 'GET',
          path: `/v1/agents/${encodeURIComponent(agentId)}/conversation-bindings`,
        }),
      enable: (
        agentId: string,
        conversationId: string,
        input: AgentConversationBindingInput = {},
      ) =>
        this.transport.request<Record<string, unknown>>({
          method: 'PUT',
          path: `/v1/agents/${encodeURIComponent(agentId)}/conversation-bindings/${encodeURIComponent(conversationId)}`,
          body: input,
        }),
      update: (
        agentId: string,
        conversationId: string,
        patch: AgentConversationBindingInput,
      ) =>
        this.transport.request<Record<string, unknown>>({
          method: 'PATCH',
          path: `/v1/agents/${encodeURIComponent(agentId)}/conversation-bindings/${encodeURIComponent(conversationId)}`,
          body: patch,
        }),
      disable: (
        agentId: string,
        conversationId: string,
        input: { threadId?: string } = {},
      ) => {
        const params = new URLSearchParams();
        if (input.threadId) params.set('threadId', input.threadId);
        return this.transport.request<{ disabled: boolean; binding?: unknown }>(
          {
            method: 'DELETE',
            path: `/v1/agents/${encodeURIComponent(agentId)}/conversation-bindings/${encodeURIComponent(conversationId)}${params.toString() ? `?${params}` : ''}`,
          },
        );
      },
    },
  };

  readonly webhooks = {
    register: (input: {
      name: string;
      url: string;
      secret?: string;
      enabled?: boolean;
    }) =>
      this.transport.request<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/webhooks',
        body: input,
      }),
    list: () =>
      this.transport.request<{ webhooks: unknown[] }>({
        method: 'GET',
        path: '/v1/webhooks',
      }),
    update: (
      webhookId: string,
      patch: {
        name?: string;
        url?: string;
        secret?: string;
        enabled?: boolean;
      },
    ) =>
      this.transport.request<Record<string, unknown>>({
        method: 'PATCH',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}`,
        body: patch,
      }),
    delete: (webhookId: string) =>
      this.transport.request<{ deleted: boolean }>({
        method: 'DELETE',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}`,
      }),
    test: (webhookId: string) =>
      this.transport.request<{ accepted: boolean; eventId: number }>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}/test`,
      }),
    replayDeadLetter: (webhookId: string) =>
      this.transport.request<{ replayed: number }>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}/replay-dead-letter`,
      }),
    purgeDeadLetter: (webhookId: string) =>
      this.transport.request<{ purged: number }>({
        method: 'POST',
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}/purge-dead-letter`,
      }),
  };

  readonly memory = {
    save: (input: MemorySaveInput) =>
      this.transport.request<{ memory: unknown }>({
        method: 'POST',
        path: '/v1/memory',
        body: input,
      }),
    search: (input: MemorySearchInput) =>
      this.transport.request<{ results: unknown[] }>({
        method: 'POST',
        path: '/v1/memory/search',
        body: input,
      }),
    list: (input: MemorySearchInput = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const entry of value) params.append(key, String(entry));
          continue;
        }
        params.set(key, String(value));
      }
      return this.transport.request<{ memories: unknown[] }>({
        method: 'GET',
        path: `/v1/memory${params.toString() ? `?${params}` : ''}`,
      });
    },
    patch: (memoryId: string, patch: MemoryPatchInput) =>
      this.transport.request<{ memory: unknown }>({
        method: 'PATCH',
        path: `/v1/memory/${encodeURIComponent(memoryId)}`,
        body: patch,
      }),
    delete: (memoryId: string, input: MemoryContext = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) params.set(key, String(value));
      }
      return this.transport.request<{ deleted: boolean }>({
        method: 'DELETE',
        path: `/v1/memory/${encodeURIComponent(memoryId)}${params.toString() ? `?${params}` : ''}`,
      });
    },
    dreaming: {
      trigger: (
        input: MemoryContext & {
          subjectType?: MemorySubjectType;
          subjectId?: string;
          phase?: DreamPhase;
          dryRun?: boolean;
        } = {},
      ) =>
        this.transport.request<{ run: unknown }>({
          method: 'POST',
          path: '/v1/memory/dreaming/trigger',
          body: input,
        }),
      status: (input: MemoryContext = {}) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (value !== undefined) params.set(key, String(value));
        }
        return this.transport.request<{ runs: unknown[] }>({
          method: 'GET',
          path: `/v1/memory/dreaming/status${params.toString() ? `?${params}` : ''}`,
        });
      },
    },
  };
}
export const createClient = (options: ClientOptions) =>
  new MyClawClient(options);

export {
  buildIngressSignaturePayload,
  signIngressRequest,
  signIngressSignaturePayload,
  verifyIngressSignature,
} from './ingress-signature.js';
export { verifyWebhookSignature } from './webhook-signature.js';
