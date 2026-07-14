import type { RequestOptions } from './types.js';

type TransportLike = {
  request<T>(options: RequestOptions): Promise<T>;
};

export type ExternalIngressTarget =
  | ConversationMessageIngressTarget
  | SessionMessageIngressTarget
  | JobTriggerIngressTarget
  | JobTemplateIngressTarget;

export interface ConversationMessageIngressTarget {
  kind: 'conversation_message';
  conversationId: string;
  agentId?: string;
  threadId?: string;
  message: string;
  senderId?: string;
  senderName?: string;
  correlationId?: string;
}

export interface SessionMessageIngressTarget {
  kind: 'session_message';
  sessionId?: string;
  conversationId?: string;
  threadId?: string;
  message: string;
  senderId?: string;
  senderName?: string;
  correlationId?: string;
  responseMode?: 'sse' | 'webhook' | 'both' | 'none';
  webhookId?: string;
}

export interface JobTriggerIngressTarget {
  kind: 'job_trigger';
  jobId: string;
}

export interface JobTemplateIngressTarget {
  kind: 'job_template';
  templateId: string;
  variables?: Record<string, string | number>;
}

export interface ExternalIngressInvokeBody<
  Target extends ExternalIngressTarget = ExternalIngressTarget,
> {
  appId?: string;
  idempotencyKey?: string;
  target: Target;
}

export function conversationMessageTarget(
  input: Omit<ConversationMessageIngressTarget, 'kind'>,
): ConversationMessageIngressTarget {
  return { kind: 'conversation_message', ...input };
}

export function createIngressesClient(transport: TransportLike) {
  return {
    create: (input: { name: string; enabled?: boolean; metadata?: unknown }) =>
      transport.request<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/ingresses',
        body: input,
      }),
    list: () =>
      transport.request<{ ingresses: unknown[] }>({
        method: 'GET',
        path: '/v1/ingresses',
      }),
    get: (ingressId: string) =>
      transport.request<Record<string, unknown>>({
        method: 'GET',
        path: `/v1/ingresses/${encodeURIComponent(ingressId)}`,
      }),
    update: (
      ingressId: string,
      patch: { name?: string; enabled?: boolean; metadata?: unknown },
    ) =>
      transport.request<Record<string, unknown>>({
        method: 'PATCH',
        path: `/v1/ingresses/${encodeURIComponent(ingressId)}`,
        body: patch,
      }),
    delete: (ingressId: string) =>
      transport.request<{ deleted: true }>({
        method: 'DELETE',
        path: `/v1/ingresses/${encodeURIComponent(ingressId)}`,
      }),
    rotate: (ingressId: string) =>
      transport.request<Record<string, unknown>>({
        method: 'POST',
        path: `/v1/ingresses/${encodeURIComponent(ingressId)}/rotate`,
      }),
  };
}
