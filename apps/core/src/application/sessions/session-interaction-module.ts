import type { AgentControlOverrides, NewMessage } from '../../domain/types.js';
import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventPublishInput,
  RuntimeResponseMode,
} from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { RuntimeEventExchange } from '../runtime-events/runtime-event-exchange.js';
import type {
  RuntimeChatMetadataRepository,
  RuntimeMessageRepository,
} from '../../domain/repositories/ops-repo.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../domain/ports/live-turns.js';
import type {
  AgentRunRepository,
  AgentSessionRepository,
  MessageRepository,
  ProviderSessionRepository,
} from '../../domain/ports/repositories.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { AgentRuntime } from '../../shared/agent-runtime.js';
import { ApplicationError } from '../common/application-error.js';
import { isValidControlId } from '../../shared/control-id.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';

type ControlResponseMode = Exclude<RuntimeResponseMode, 'sse'> | 'sse';

export type SessionAppRecord = {
  sessionId: string;
  appId: string;
  conversationId: string;
  conversationJid: string;
  workspaceKey: string;
  title?: string | null;
  defaultResponseMode: ControlResponseMode;
  defaultWebhookId: string | null;
};

export type SessionResponseRouteRecord = {
  responseMode: ControlResponseMode;
  webhookId: string | null;
  correlationId: string | null;
};

export interface SessionControlPort {
  ensureAppSession(input: {
    appId: string;
    conversationId: string;
    conversationJid: string;
    folder: string;
    title?: string | null;
    defaultResponseMode?: ControlResponseMode;
    defaultWebhookId?: string | null;
  }): Promise<SessionAppRecord>;
  getAppSessionById(sessionId: string): Promise<SessionAppRecord | undefined>;
  getAppSessionByChatJid(
    conversationJid: string,
  ): Promise<SessionAppRecord | undefined>;
  getWebhookById(
    webhookId: string,
    appId: string,
  ): Promise<{ webhookId: string } | undefined>;
  upsertAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
    responseMode: ControlResponseMode;
    webhookId?: string | null;
    correlationId?: string | null;
  }): Promise<SessionResponseRouteRecord>;
  getAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
  }): Promise<SessionResponseRouteRecord | undefined>;
}

export type SessionInteractionDeps = {
  control: SessionControlPort;
  ops: RuntimeChatMetadataRepository & RuntimeMessageRepository;
  repositories: {
    agentSessions: AgentSessionRepository;
    providerSessions: ProviderSessionRepository;
    messages: MessageRepository;
    agentRuns: AgentRunRepository;
  };
  runtimeEvents: RuntimeEventExchange;
  liveAdmissionAppId?: string | null;
  getConfiguredAgentRuntime?: (agentFolder: string) => AgentRuntime | undefined;
  now: () => IsoTimestamp;
  createId: () => string;
  stableHash: (input: string) => string;
};

export type SessionQueueIntent = {
  conversationJid: string;
  threadId: string | null;
  queueKey: string;
  durableAdmissionCreated: boolean;
};

export class SessionInteractionModule {
  constructor(private readonly deps: SessionInteractionDeps) {}

  async ensureSession(input: {
    appId: string;
    assertedAppId?: string | null;
    conversationId: string;
    title?: string | null;
    responseMode?: unknown;
    webhookId?: string | null;
  }): Promise<{
    session: SessionAppRecord;
    registerGroup: { conversationJid: string; group: AppGroupRegistration };
  }> {
    assertAppScope(input.appId, input.assertedAppId);
    const conversationId = input.conversationId.trim();
    if (!conversationId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'conversationId is required',
      );
    }
    if (!isValidControlId(input.appId) || !isValidControlId(conversationId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'appId and conversationId must contain only letters, numbers, dot, underscore, or dash',
      );
    }
    const conversationJid = `app:${input.appId}:${conversationId}`;
    const group = makeAppGroup({
      appId: input.appId,
      conversationId,
      conversationJid,
      identityHash: this.deps
        .stableHash(`${input.appId}\0${conversationId}`)
        .slice(0, 12),
      addedAt: this.deps.now(),
    });
    const defaultWebhookId = await this.resolveOwnedWebhookId(
      input.appId,
      input.webhookId ?? null,
    );
    const session = await this.deps.control.ensureAppSession({
      appId: input.appId,
      conversationId,
      conversationJid,
      folder: group.folder,
      title: input.title ?? null,
      defaultResponseMode: normalizeResponseMode(input.responseMode, 'sse'),
      defaultWebhookId,
    });
    return { session, registerGroup: { conversationJid, group } };
  }

  async getSessionDetails(input: {
    appId: string;
    sessionId: string;
  }): Promise<{ session: unknown; providerSession: unknown | null }> {
    const appSession = await this.requireSession(input);
    const session = await this.deps.repositories.agentSessions.getAgentSession(
      appSession.sessionId as never,
    );
    if (!session) {
      throw new ApplicationError('NOT_FOUND', 'Session not found');
    }
    const providerSession =
      await this.deps.repositories.providerSessions.getLatestProviderSession({
        agentSessionId: session.id,
      });
    return {
      session,
      providerSession: providerSession
        ? {
            provider: providerSession.provider,
            status: providerSession.status,
            hasProviderResume: hasProviderResumeHandle(providerSession),
            createdAt: providerSession.createdAt,
            updatedAt: providerSession.updatedAt,
          }
        : null,
    };
  }

  async listMessages(input: {
    appId: string;
    sessionId: string;
    limit: number;
  }): Promise<{ messages: unknown[] }> {
    const session = await this.requireSession(input);
    if (!session.conversationId) return { messages: [] };
    const messages = await this.deps.repositories.messages.listRecentMessages({
      conversationId: session.conversationId as never,
      limit: input.limit,
    });
    return { messages };
  }

  async listRuns(input: {
    appId: string;
    sessionId: string;
    limit: number;
  }): Promise<{ runs: unknown[] }> {
    const appSession = await this.requireSession(input);
    const session = await this.deps.repositories.agentSessions.getAgentSession(
      appSession.sessionId as never,
    );
    if (!session) return { runs: [] };
    const runs = await this.deps.repositories.agentRuns.listAgentRunsBySession({
      sessionId: session.id,
      limit: input.limit,
    });
    return { runs };
  }

  async acceptMessage(input: {
    appId: string;
    sessionId: string;
    message: string;
    senderId?: string;
    senderName?: string;
    threadId?: string;
    correlationId?: string | null;
    responseMode?: unknown;
    webhookId?: string | null;
    responseSchema?: Record<string, unknown>;
    agentControls?: AgentControlOverrides;
    durableLiveAdmission?: boolean;
    beforeDurableAdmission?: () => Promise<void> | void;
  }): Promise<{
    accepted: true;
    messageId: string;
    acceptedEventId: number;
    enqueue: SessionQueueIntent;
  }> {
    const session = await this.requireSession(input);
    const text = input.message.trim();
    if (!text) {
      throw new ApplicationError('INVALID_REQUEST', 'message is required');
    }
    if (
      input.responseSchema &&
      this.deps.getConfiguredAgentRuntime?.(session.workspaceKey) !== 'inline'
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'response_schema requires an inline agent runtime',
      );
    }
    const threadId = input.threadId?.trim() || null;
    const responseMode = normalizeResponseMode(
      input.responseMode,
      session.defaultResponseMode,
    );
    const webhookId = await this.resolveOwnedWebhookId(
      input.appId,
      input.webhookId ?? session.defaultWebhookId,
    );
    const now = this.deps.now();
    const messageId = this.deps.createId();
    const message: NewMessage = {
      id: messageId,
      chat_jid: session.conversationJid,
      provider: 'app',
      sender: input.senderId ?? 'sdk',
      sender_name: input.senderName ?? 'SDK',
      content: text,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
      external_message_id: messageId,
      thread_id: threadId ?? undefined,
      responseSchema: input.responseSchema,
      agentControls: input.agentControls,
    };
    await this.deps.ops.storeChatMetadata(
      session.conversationJid,
      now,
      session.title ?? session.conversationJid,
      'app',
      true,
    );
    await this.deps.control.upsertAppResponseRoute({
      sessionId: session.sessionId,
      threadId,
      responseMode,
      webhookId,
      correlationId: input.correlationId ?? null,
    });
    const acceptedEvent: RuntimeEventPublishInput = {
      appId: session.appId as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
      payload: {
        messageId,
        text,
        threadId,
      },
      actor: 'sdk',
      sessionId: session.sessionId as never,
      threadId: threadId ? (threadId as never) : undefined,
      correlationId: input.correlationId ?? null,
      responseMode,
      webhookId,
    };
    let durableAdmissionCreated = false;
    let admissionResult: LiveAdmissionWorkItemEnqueueResult | undefined;
    let accepted: RuntimeEvent;
    const runtimeEventsWithLiveAdmission = this.deps.runtimeEvents as {
      publishWithLiveAdmissionMessage?: RuntimeEventExchange['publishWithLiveAdmissionMessage'];
    };
    const publishWithLiveAdmissionMessage =
      runtimeEventsWithLiveAdmission.publishWithLiveAdmissionMessage?.bind(
        this.deps.runtimeEvents,
      );
    const useDurableAdmission =
      input.durableLiveAdmission !== false &&
      publishWithLiveAdmissionMessage &&
      this.deps.liveAdmissionAppId !== null;
    if (useDurableAdmission) {
      await input.beforeDurableAdmission?.();
      const liveAdmissionAppId = this.deps.liveAdmissionAppId ?? session.appId;
      const result = await publishWithLiveAdmissionMessage(acceptedEvent, {
        message,
        liveAdmission: {
          appId: liveAdmissionAppId,
          triggerDecision: {
            source: 'sdk_session',
            responseMode,
          },
          now,
        },
      });
      accepted = result.event;
      admissionResult = result.liveAdmissionResult;
      durableAdmissionCreated = !!admissionResult;
    } else {
      await this.deps.ops.storeMessage(message);
      accepted = await this.deps.runtimeEvents.publish(acceptedEvent);
    }
    if (admissionResult) {
      await this.deps.ops.notifyLiveAdmissionWorkItem?.(admissionResult);
    }
    return {
      accepted: true,
      messageId,
      acceptedEventId: accepted.eventId,
      enqueue: {
        conversationJid: session.conversationJid,
        threadId,
        queueKey: makeSessionQueueKey(session.conversationJid, threadId),
        durableAdmissionCreated,
      },
    };
  }

  async listEvents(input: {
    appId: string;
    sessionId: string;
    afterEventId?: number;
    limit?: number;
  }): Promise<RuntimeEvent[]> {
    const session = await this.requireSession(input);
    return this.deps.runtimeEvents.list(this.eventFilter(session, input));
  }

  async subscribeEvents(input: {
    appId: string;
    sessionId: string;
    afterEventId?: number;
    limit?: number;
  }) {
    const session = await this.requireSession(input);
    return this.deps.runtimeEvents.subscribe(this.eventFilter(session, input));
  }

  async waitForVisibleEvent(input: {
    appId: string;
    sessionId: string;
    afterEventId?: number;
    timeoutMs: number;
  }): Promise<RuntimeEvent> {
    const subscription = await this.subscribeEvents(input);
    const startedAt = currentTimeMs();
    try {
      while (currentTimeMs() - startedAt < input.timeoutMs) {
        const remaining = input.timeoutMs - (currentTimeMs() - startedAt);
        const events = await subscription.next({ timeoutMs: remaining });
        const visible = events.find(isVisibleWaitEvent);
        if (visible) return visible;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      subscription.close();
    }
    throw new ApplicationError(
      'WAIT_TIMEOUT',
      'Timed out waiting for session event',
    );
  }

  async publishOutboundEvent(input: {
    conversationJid: string;
    eventType: RuntimeEventPublishInput['eventType'];
    payload: Record<string, unknown>;
  }): Promise<{ emitted: boolean; eventId?: number }> {
    const session = await this.deps.control.getAppSessionByChatJid(
      input.conversationJid,
    );
    if (!session) return { emitted: false };
    const threadId =
      typeof input.payload.threadId === 'string'
        ? input.payload.threadId
        : null;
    const route = await this.deps.control.getAppResponseRoute({
      sessionId: session.sessionId,
      threadId,
    });
    const event = await this.deps.runtimeEvents.publish({
      appId: session.appId as never,
      eventType: input.eventType,
      payload: input.payload,
      actor: 'agent',
      sessionId: session.sessionId as never,
      threadId: threadId ? (threadId as never) : undefined,
      correlationId: route?.correlationId ?? null,
      responseMode: route?.responseMode ?? session.defaultResponseMode,
      webhookId: route ? route.webhookId : session.defaultWebhookId,
    });
    return { emitted: true, eventId: event.eventId };
  }

  private async requireSession(input: {
    appId: string;
    sessionId: string;
  }): Promise<SessionAppRecord> {
    const session = await this.deps.control.getAppSessionById(input.sessionId);
    if (!session) {
      throw new ApplicationError('NOT_FOUND', 'Session not found');
    }
    if (session.appId !== input.appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this session',
      );
    }
    return session;
  }

  private async resolveOwnedWebhookId(
    appId: string,
    rawWebhookId: string | null,
  ): Promise<string | null> {
    const webhookId = rawWebhookId?.trim();
    if (!webhookId) return null;
    const webhook = await this.deps.control.getWebhookById(webhookId, appId);
    if (!webhook) {
      throw new ApplicationError('NOT_FOUND', 'Webhook not found');
    }
    return webhook.webhookId;
  }

  private eventFilter(
    session: SessionAppRecord,
    input: { afterEventId?: number; limit?: number },
  ): RuntimeEventFilter {
    return {
      appId: session.appId as never,
      sessionId: session.sessionId as never,
      afterEventId:
        input.afterEventId && input.afterEventId > 0
          ? (input.afterEventId as never)
          : undefined,
      limit: input.limit ?? 100,
    };
  }
}

export function assertAppScope(
  resolvedAppId: string,
  assertedAppId?: string | null,
): void {
  const trimmed = assertedAppId?.trim();
  if (trimmed && trimmed !== resolvedAppId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Request appId does not match authenticated app scope',
    );
  }
}

export function normalizeResponseMode(
  raw: unknown,
  fallback: ControlResponseMode,
): ControlResponseMode {
  return raw === 'webhook' || raw === 'both' || raw === 'none' || raw === 'sse'
    ? raw
    : fallback;
}

type AppGroupRegistration = {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger: boolean;
};

export function makeAppGroup(input: {
  appId: string;
  conversationId: string;
  conversationJid: string;
  identityHash: string;
  addedAt: string;
}): AppGroupRegistration {
  const app = sanitizeSegment(input.appId) || 'app';
  const conversation = sanitizeSegment(input.conversationId) || 'session';
  const prefix = `app_${input.identityHash}_`;
  const remaining = 96 - prefix.length;
  const appPart = app.slice(0, Math.max(8, Math.floor(remaining * 0.4)));
  const conversationPart = conversation.slice(
    0,
    Math.max(8, remaining - appPart.length - 1),
  );
  return {
    name: `${input.appId}:${input.conversationId}`,
    folder: `${prefix}${appPart}_${conversationPart}`.slice(0, 96),
    trigger: '',
    added_at: input.addedAt,
    requiresTrigger: false,
  };
}

export function makeSessionQueueKey(
  conversationJid: string,
  threadId?: string | null,
): string {
  const normalized = threadId?.trim();
  if (!normalized) return conversationJid;
  return `${conversationJid}::thread:${encodeURIComponent(normalized)}`;
}

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function isVisibleWaitEvent(event: RuntimeEvent): boolean {
  return (
    event.eventType === RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND ||
    event.eventType === RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING
  );
}

function hasProviderResumeHandle(value: {
  externalSessionId?: unknown;
  providerRef?: { value?: unknown } | null;
  metadata?: unknown;
}): boolean {
  return (
    hasNonEmptyString(value.externalSessionId) ||
    hasNonEmptyString(value.providerRef?.value) ||
    metadataContainsResumeHandle(value.metadata, 0)
  );
}

function metadataContainsResumeHandle(value: unknown, depth: number): boolean {
  if (depth > 4 || value == null) return false;
  if (Array.isArray(value)) {
    return value.some((entry) =>
      metadataContainsResumeHandle(entry, depth + 1),
    );
  }
  if (typeof value !== 'object') return false;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /(externalSessionId|providerSessionId|latestProviderSessionId|newSessionId|sessionId|session_id|resume|artifact)/i.test(
        key,
      ) &&
      hasNonEmptyString(entry)
    ) {
      return true;
    }
    if (metadataContainsResumeHandle(entry, depth + 1)) {
      return true;
    }
  }
  return false;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
