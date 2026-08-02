import type { AgentControlOverrides } from '../../domain/types.js';
import type { RuntimeEvent, RuntimeEventPublishInput, RuntimeResponseMode } from '../../domain/events/events.js';
import type { RuntimeEventExchange } from '../runtime-events/runtime-event-exchange.js';
import type { RuntimeChatMetadataRepository, RuntimeMessageRepository } from '../../domain/repositories/ops-repo.js';
import type { AgentRepository, AgentRunRepository, AgentSessionRepository, MessageRepository, ProviderSessionRepository } from '../../domain/ports/repositories.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { AgentRuntime } from '../../shared/agent-runtime.js';
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
    getAppSessionByChatJid(conversationJid: string): Promise<SessionAppRecord | undefined>;
    getWebhookById(webhookId: string, appId: string): Promise<{
        webhookId: string;
    } | undefined>;
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
        agents: AgentRepository;
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
export declare class SessionInteractionModule {
    private readonly deps;
    constructor(deps: SessionInteractionDeps);
    ensureSession(input: {
        appId: string;
        assertedAppId?: string | null;
        agentId?: string | null;
        conversationId: string;
        title?: string | null;
        responseMode?: unknown;
        webhookId?: string | null;
    }): Promise<{
        session: SessionAppRecord;
        registerGroup: {
            conversationJid: string;
            group: AppGroupRegistration;
        };
    }>;
    getSessionDetails(input: {
        appId: string;
        sessionId: string;
    }): Promise<{
        session: unknown;
        providerSession: unknown | null;
    }>;
    listMessages(input: {
        appId: string;
        sessionId: string;
        limit: number;
    }): Promise<{
        messages: unknown[];
    }>;
    listRuns(input: {
        appId: string;
        sessionId: string;
        limit: number;
    }): Promise<{
        runs: unknown[];
    }>;
    acceptMessage(input: {
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
    }>;
    listEvents(input: {
        appId: string;
        sessionId: string;
        afterEventId?: number;
        limit?: number;
    }): Promise<RuntimeEvent[]>;
    subscribeEvents(input: {
        appId: string;
        sessionId: string;
        afterEventId?: number;
        limit?: number;
    }): Promise<import("../runtime-events/runtime-event-exchange.js").RuntimeEventSubscription>;
    waitForVisibleEvent(input: {
        appId: string;
        sessionId: string;
        afterEventId?: number;
        timeoutMs: number;
    }): Promise<RuntimeEvent>;
    publishOutboundEvent(input: {
        conversationJid: string;
        eventType: RuntimeEventPublishInput['eventType'];
        payload: Record<string, unknown>;
    }): Promise<{
        emitted: boolean;
        eventId?: number;
    }>;
    requireSession(input: {
        appId: string;
        sessionId: string;
    }): Promise<SessionAppRecord>;
    private resolveOwnedWebhookId;
    private eventFilter;
}
export declare function assertAppScope(resolvedAppId: string, assertedAppId?: string | null): void;
export declare function normalizeResponseMode(raw: unknown, fallback: ControlResponseMode): ControlResponseMode;
type AppGroupRegistration = {
    name: string;
    folder: string;
    trigger: string;
    added_at: string;
    requiresTrigger: boolean;
};
export declare function makeAppGroup(input: {
    appId: string;
    conversationId: string;
    conversationJid: string;
    identityHash: string;
    addedAt: string;
}): AppGroupRegistration;
export declare function makeSessionQueueKey(conversationJid: string, threadId?: string | null): string;
export {};
