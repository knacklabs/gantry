import type { Pool } from 'pg';
import type { Agent, AgentConfigVersion } from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type { ConversationInstall, ConversationApprover, ProviderAccount, ProviderId } from '../../../../domain/provider/provider.js';
import type { Conversation, ConversationThread } from '../../../../domain/conversation/conversation.js';
import type { AgentRun } from '../../../../domain/events/events.js';
import type { Message } from '../../../../domain/messages/messages.js';
import type { PermissionDecision, PermissionPolicy, PermissionRule } from '../../../../domain/permissions/permissions.js';
import type { AgentConfigRepository, AgentRepository, AgentRunRepository, AgentSessionDigestRepository, AgentSessionRepository, AgentSessionSummaryRepository, AppRepository, CapabilitySecretRepository, ModelCredentialRepository, ProviderAccountRepository, ConversationRepository, MessageRepository, McpServerRepository, PendingAccessRequestsRepository, PermissionRepository, ProviderSessionRepository, RuntimeEventRepository, SandboxRepository, SkillCatalogRepository, ToolCatalogRepository, OutboundDeliveryRepository } from '../../../../domain/ports/repositories.js';
import type { SandboxLease, SandboxProfile, WorkspaceSnapshot } from '../../../../domain/sandbox/sandbox.js';
import type { AgentSession } from '../../../../domain/sessions/sessions.js';
import { type CanonicalDb } from './canonical-graph-repository.postgres.js';
import type { WorkerCoordinationRepository } from '../../../../domain/ports/worker-coordination.js';
import type { LiveTurnCommandNotifier, LiveTurnCoordinationRepository } from '../../../../domain/ports/live-turns.js';
import { PostgresProactiveSurfacingRepository } from './proactive-surfacing-repository.postgres.js';
import type { RuntimeDependencyRepository, SettingsRevisionRepository, StaleRuntimeDependencyLister } from '../../../../domain/ports/fleet-capability-state.js';
import type { AsyncTaskRepository } from '../../../../domain/ports/async-tasks.js';
import type { PatternCandidateRepository } from '../../../../domain/ports/pattern-candidates.js';
import type { ObserverInsightRepository } from '../../../../domain/ports/observer-insights.js';
import type { ChatBatchRepository } from '../../../../domain/ports/chat-batches.js';
import type { PermissionPromotionRepository } from '../../../../domain/ports/permission-promotion.js';
import type { PermissionDecisionMemoryRepository } from '../../../../domain/ports/permission-decision-memory.js';
import type { GroupJoinOnboardingRepository } from '../../../../domain/ports/group-join-onboarding.js';
export interface PostgresDomainRepositoryBundle {
    apps: AppRepository;
    agents: AgentRepository;
    agentConfigs: AgentConfigRepository;
    providerAccounts: ProviderAccountRepository;
    conversations: ConversationRepository;
    messages: MessageRepository;
    agentSessions: AgentSessionRepository;
    agentSessionDigests: AgentSessionDigestRepository;
    providerSessions: ProviderSessionRepository;
    agentSessionSummaries: AgentSessionSummaryRepository;
    agentRuns: AgentRunRepository;
    runtimeEvents: RuntimeEventRepository;
    tools: ToolCatalogRepository;
    skills: SkillCatalogRepository;
    capabilitySecrets: CapabilitySecretRepository;
    modelCredentials: ModelCredentialRepository;
    mcpServers: McpServerRepository;
    permissions: PermissionRepository;
    pendingAccessRequests: PendingAccessRequestsRepository;
    sandboxes: SandboxRepository;
    outboundDeliveries: OutboundDeliveryRepository;
    workerCoordination: WorkerCoordinationRepository;
    liveTurns: LiveTurnCoordinationRepository;
    runtimeDependencies: RuntimeDependencyRepository & StaleRuntimeDependencyLister;
    settingsRevisions: SettingsRevisionRepository;
    asyncTasks: AsyncTaskRepository;
    patternCandidates: PatternCandidateRepository;
    proactiveSurfacing: PostgresProactiveSurfacingRepository;
    observerInsights: ObserverInsightRepository;
    chatBatches: ChatBatchRepository;
    permissionPromotions: PermissionPromotionRepository;
    permissionDecisionMemory: PermissionDecisionMemoryRepository;
    groupJoinOnboarding: GroupJoinOnboardingRepository;
}
export declare function parseRuntimeSecretRefsJson(value: unknown, providerId: string): Record<string, string>;
export declare class PostgresAppRepository implements AppRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getApp(id: App['id']): Promise<App | null>;
    saveApp(app: App): Promise<void>;
}
export declare class PostgresAgentConfigRepository implements AgentConfigRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getConfigVersion(id: AgentConfigVersion['id']): Promise<AgentConfigVersion | null>;
    saveConfigVersion(version: AgentConfigVersion): Promise<void>;
}
export declare class PostgresProviderAccountRepository implements ProviderAccountRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    listProviderAccounts(appId: ProviderAccount['appId']): Promise<ProviderAccount[]>;
    getProviderAccount(id: ProviderAccount['id']): Promise<ProviderAccount | null>;
    private providerAccountFromRow;
    saveProviderAccount(providerAccount: ProviderAccount): Promise<void>;
    updateProviderAccount(input: {
        appId: ProviderAccount['appId'];
        id: ProviderAccount['id'];
        patch: {
            externalIdentityRef?: ProviderAccount['externalIdentityRef'] | null;
            label?: string;
            status?: ProviderAccount['status'];
            config?: ProviderAccount['config'];
            runtimeSecretRefs?: ProviderAccount['runtimeSecretRefs'];
        };
        updatedAt: string;
    }): Promise<ProviderAccount | null>;
    disableProviderAccount(input: {
        appId: ProviderAccount['appId'];
        id: ProviderAccount['id'];
        updatedAt: string;
    }): Promise<ProviderAccount | null>;
    saveConversationInstall(binding: ConversationInstall): Promise<void>;
    disableConversationInstall(input: {
        appId: App['id'];
        agentId: Agent['id'];
        conversationId: Conversation['id'];
        threadId?: ConversationThread['id'];
        updatedAt: string;
    }): Promise<ConversationInstall | null>;
    getConversationInstall(input: {
        appId: App['id'];
        agentId: Agent['id'];
        conversationId: Conversation['id'];
        threadId?: ConversationThread['id'];
        exactThreadId?: boolean;
    }): Promise<ConversationInstall | null>;
    isAgentEnabledInConversation(input: {
        appId: App['id'];
        agentId: Agent['id'];
        conversationId: Conversation['id'];
        threadId?: ConversationThread['id'];
    }): Promise<boolean>;
    listConversationInstalls(appId: App['id'], agentId?: Agent['id']): Promise<ConversationInstall[]>;
    listConversationInstallsByConversation(input: {
        appId: App['id'];
        conversationId: Conversation['id'];
    }): Promise<ConversationInstall[]>;
    private bindingFromRow;
}
export declare class PostgresConversationRepository implements ConversationRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    listConversations(input: {
        appId: Conversation['appId'];
        providerAccountId?: ProviderAccount['id'];
    }): Promise<Conversation[]>;
    getConversation(id: Conversation['id']): Promise<Conversation | null>;
    getConversationByExternalRef(input: {
        appId: App['id'];
        providerId: ProviderId;
        providerAccountId: ProviderAccount['id'];
        externalConversationId: string;
    }): Promise<Conversation | null>;
    findConversationByExternalValue(input: {
        appId: App['id'];
        externalConversationId: string;
    }): Promise<Conversation | null>;
    getThread(id: ConversationThread['id']): Promise<ConversationThread | null>;
    getThreadByExternalRef(input: {
        appId: App['id'];
        providerId: ProviderId;
        conversationId: Conversation['id'];
        externalThreadId: string;
    }): Promise<ConversationThread | null>;
    saveConversation(conversation: Conversation): Promise<void>;
    saveThread(thread: ConversationThread): Promise<void>;
    listThreads(conversationId: Conversation['id']): Promise<ConversationThread[]>;
    listParticipantExternalUserIds(conversationId: Conversation['id']): Promise<string[]>;
    listConversationApprovers(conversationId: Conversation['id']): Promise<ConversationApprover[]>;
    listConversationApproversForConversations(conversationIds: readonly Conversation['id'][]): Promise<ConversationApprover[]>;
    private listConversationApproverRows;
    replaceConversationApprovers(input: {
        appId: App['id'];
        conversationId: Conversation['id'];
        externalUserIds: string[];
        updatedAt: string;
    }): Promise<ConversationApprover[]>;
    private conversationFromRow;
    private threadFromRow;
}
export declare class PostgresMessageRepository implements MessageRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    listConversationIdsForJid(jid: string): Promise<Conversation['id'][]>;
    getMessage(id: Message['id']): Promise<Message | null>;
    saveMessage(message: Message): Promise<void>;
    private writeMessage;
    listMessages(input: {
        conversationId: Conversation['id'];
        threadId?: ConversationThread['id'];
        after?: string;
        limit?: number;
    }): Promise<Message[]>;
    listRecentMessages(input: {
        conversationId: Conversation['id'];
        threadId?: ConversationThread['id'];
        after?: string;
        limit?: number;
    }): Promise<Message[]>;
    private messageFromRows;
}
export declare class PostgresAgentRunRepository implements AgentRunRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getAgentRun(id: AgentRun['id']): Promise<AgentRun | null>;
    saveAgentRun(run: AgentRun): Promise<void>;
    listAgentRunsBySession(input: {
        sessionId: AgentSession['id'];
        limit?: number;
    }): Promise<AgentRun[]>;
    private runFromRow;
}
export declare class PostgresPermissionRepository implements PermissionRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    savePolicy(policy: PermissionPolicy): Promise<void>;
    saveRule(rule: PermissionRule): Promise<void>;
    saveDecision(decision: PermissionDecision): Promise<void>;
    getDecision(id: PermissionDecision['id']): Promise<PermissionDecision | null>;
}
export declare class PostgresSandboxRepository implements SandboxRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getSandboxProfile(id: SandboxProfile['id']): Promise<SandboxProfile | null>;
    saveSandboxProfile(profile: SandboxProfile): Promise<void>;
    getSandboxLease(id: SandboxLease['id']): Promise<SandboxLease | null>;
    saveSandboxLease(lease: SandboxLease): Promise<void>;
    saveWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void>;
    getWorkspaceSnapshot(id: WorkspaceSnapshot['id']): Promise<WorkspaceSnapshot | null>;
}
export declare function createPostgresDomainRepositories(db: CanonicalDb, _pool?: Pool, options?: {
    liveTurnCommandNotifier?: LiveTurnCommandNotifier;
    maxLiveAdmissionBacklog?: number;
}): PostgresDomainRepositoryBundle;
