import type {
  Agent,
  AgentConfigVersion,
  AgentConfigVersionId,
  AgentId,
} from '../agent/agent.js';
import type { App, AppId } from '../app/app.js';
import type {
  AgentConversationBinding,
  ConversationApprover,
  ProviderConnection,
  ProviderConnectionId,
  ProviderId,
} from '../provider/provider.js';
import type {
  Conversation,
  ConversationId,
  ConversationThread,
  ConversationThreadId,
  ExternalConversationId,
  UserId,
} from '../conversation/conversation.js';
import type {
  AgentRun,
  AgentRunId,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventPublishInput,
} from '../events/events.js';
import type { Message, MessageId } from '../messages/messages.js';
import type {
  ClaimedOutboundDeliveryItem,
  OutboundDelivery,
  OutboundDeliveryFinalAnswer,
  OutboundDeliveryId,
  OutboundDeliveryItem,
  OutboundDeliveryItemId,
  OutboundDeliveryReceipt,
  OutboundDeliveryReceiptId,
  OutboundDeliveryResolvedDestination,
} from '../outbound-delivery/outbound-delivery.js';
import type {
  AgentMcpServerBinding,
  MaterializedMcpServer,
  McpServerAuditEvent,
  McpServerDefinition,
  McpServerId,
  McpServerVersion,
  McpServerVersionId,
} from '../mcp/mcp-servers.js';
import type {
  PermissionDecision,
  PermissionDecisionId,
  PermissionPolicy,
  PermissionRule,
} from '../permissions/permissions.js';
import type {
  SandboxLease,
  SandboxLeaseId,
  SandboxProfile,
  SandboxProfileId,
  WorkspaceSnapshot,
  WorkspaceSnapshotId,
} from '../sandbox/sandbox.js';
import type {
  AgentSessionDigest,
  AgentSessionDigestScopeMetadata,
  AgentSessionDigestId,
  AgentSession,
  AgentSessionId,
  AgentSessionSummary,
  AgentSessionSummaryId,
  ProviderSession,
  ProviderSessionId,
} from '../sessions/sessions.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
  SkillId,
} from '../skills/skills.js';
import type {
  AgentToolBinding,
  ToolCatalogItem,
  ToolId,
} from '../tools/tools.js';

export interface AppRepository {
  getApp(id: AppId): Promise<App | null>;
  saveApp(app: App): Promise<void>;
}

export interface AgentRepository {
  getAgent(id: AgentId): Promise<Agent | null>;
  listAgents(appId: AppId): Promise<Agent[]>;
  saveAgent(agent: Agent): Promise<void>;
  replaceAgentCapabilityBindings(input: {
    appId: AppId;
    agentId: AgentId;
    toolBindings: AgentToolBinding[];
    skillBindings: AgentSkillBinding[];
    mcpBindings: AgentMcpServerBinding[];
    updatedAt: string;
  }): Promise<void>;
  disableAgent(input: {
    appId: AppId;
    agentId: AgentId;
    updatedAt: string;
  }): Promise<Agent | null>;
}

export interface AgentConfigRepository {
  getConfigVersion(
    id: AgentConfigVersionId,
  ): Promise<AgentConfigVersion | null>;
  saveConfigVersion(version: AgentConfigVersion): Promise<void>;
}

export interface ProviderConnectionRepository {
  listProviderConnections(appId: AppId): Promise<ProviderConnection[]>;
  getProviderConnection(
    id: ProviderConnectionId,
  ): Promise<ProviderConnection | null>;
  saveProviderConnection(providerConnection: ProviderConnection): Promise<void>;
  updateProviderConnection(input: {
    appId: AppId;
    id: ProviderConnectionId;
    patch: {
      externalInstallationRef?:
        | ProviderConnection['externalInstallationRef']
        | null;
      label?: string;
      status?: ProviderConnection['status'];
      config?: ProviderConnection['config'];
      runtimeSecretRefs?: ProviderConnection['runtimeSecretRefs'];
    };
    updatedAt: string;
  }): Promise<ProviderConnection | null>;
  disableProviderConnection(input: {
    appId: AppId;
    id: ProviderConnectionId;
    updatedAt: string;
  }): Promise<ProviderConnection | null>;
  saveAgentConversationBinding(
    binding: AgentConversationBinding,
  ): Promise<void>;
  disableAgentConversationBinding(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
    updatedAt: string;
  }): Promise<AgentConversationBinding | null>;
  getAgentConversationBinding(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
  }): Promise<AgentConversationBinding | null>;
  isAgentEnabledInConversation(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
  }): Promise<boolean>;
  listAgentConversationBindings(
    appId: AppId,
    agentId?: AgentId,
  ): Promise<AgentConversationBinding[]>;
  listAgentConversationBindingsByConversation(input: {
    appId: AppId;
    conversationId: ConversationId;
  }): Promise<AgentConversationBinding[]>;
}

export interface ConversationRepository {
  listConversations(input: {
    appId: AppId;
    providerConnectionId?: ProviderConnectionId;
  }): Promise<Conversation[]>;
  getConversation(id: ConversationId): Promise<Conversation | null>;
  getConversationByExternalRef(input: {
    appId: AppId;
    providerId: ProviderId;
    providerConnectionId: ProviderConnectionId;
    externalConversationId: ExternalConversationId | string;
  }): Promise<Conversation | null>;
  findConversationByExternalValue(input: {
    appId: AppId;
    externalConversationId: ExternalConversationId | string;
  }): Promise<Conversation | null>;
  getThread(id: ConversationThreadId): Promise<ConversationThread | null>;
  getThreadByExternalRef(input: {
    appId: AppId;
    providerId: ProviderId;
    conversationId: ConversationId;
    externalThreadId: string;
  }): Promise<ConversationThread | null>;
  saveConversation(conversation: Conversation): Promise<void>;
  saveThread(thread: ConversationThread): Promise<void>;
  listThreads(conversationId: ConversationId): Promise<ConversationThread[]>;
  listParticipantExternalUserIds(
    conversationId: ConversationId,
  ): Promise<string[]>;
  listConversationApprovers(
    conversationId: ConversationId,
  ): Promise<ConversationApprover[]>;
  listConversationApproversForConversations(
    conversationIds: readonly ConversationId[],
  ): Promise<ConversationApprover[]>;
  replaceConversationApprovers(input: {
    appId: AppId;
    conversationId: ConversationId;
    externalUserIds: string[];
    updatedAt: string;
  }): Promise<ConversationApprover[]>;
}

export interface MessageRepository {
  getMessage(id: MessageId): Promise<Message | null>;
  saveMessage(message: Message): Promise<void>;
  listMessages(input: {
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
    after?: string;
    limit?: number;
  }): Promise<Message[]>;
  listRecentMessages(input: {
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
    after?: string;
    limit?: number;
  }): Promise<Message[]>;
}

export interface AgentSessionRepository {
  getAgentSession(id: AgentSessionId): Promise<AgentSession | null>;
  getAgentSessionByKey(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
    userId?: UserId;
  }): Promise<AgentSession | null>;
  saveAgentSession(session: AgentSession): Promise<void>;
}

export interface ProviderSessionRepository {
  getProviderSession(id: ProviderSessionId): Promise<ProviderSession | null>;
  getLatestProviderSession(input: {
    agentSessionId: AgentSessionId;
    provider?: string;
  }): Promise<ProviderSession | null>;
  saveProviderSession(session: ProviderSession): Promise<void>;
  markProviderSessionStatus(
    id: ProviderSessionId,
    status: ProviderSession['status'],
    updatedAt: string,
  ): Promise<void>;
}

export interface AgentSessionSummaryRepository {
  getAgentSessionSummary(
    id: AgentSessionSummaryId,
  ): Promise<AgentSessionSummary | null>;
  getLatestAgentSessionSummary(
    agentSessionId: AgentSessionId,
  ): Promise<AgentSessionSummary | null>;
  listRecentAgentSessionSummaries?(input: {
    agentSessionId: AgentSessionId;
    limit?: number;
  }): Promise<AgentSessionSummary[]>;
  saveAgentSessionSummary(summary: AgentSessionSummary): Promise<void>;
}

export interface AgentSessionDigestRepository {
  getAgentSessionDigest(
    id: AgentSessionDigestId,
  ): Promise<AgentSessionDigest | null>;
  listAgentSessionDigests(input: {
    agentSessionId: AgentSessionId;
    trigger?: AgentSessionDigest['trigger'];
    sessionScope?: AgentSessionDigestScopeMetadata['sessionScope'];
    limit?: number;
  }): Promise<AgentSessionDigest[]>;
  saveAgentSessionDigest(digest: AgentSessionDigest): Promise<void>;
}

export interface AgentRunRepository {
  getAgentRun(id: AgentRunId): Promise<AgentRun | null>;
  saveAgentRun(run: AgentRun): Promise<void>;
  listAgentRunsBySession(input: {
    sessionId: AgentSessionId;
    limit?: number;
  }): Promise<AgentRun[]>;
}

export interface RuntimeEventRepository {
  appendRuntimeEvent(input: RuntimeEventPublishInput): Promise<RuntimeEvent>;
  listRuntimeEvents(filter: RuntimeEventFilter): Promise<RuntimeEvent[]>;
}

export interface OutboundDeliveryRepository {
  enqueueDelivery(input: {
    delivery: OutboundDelivery;
    finalAnswer: OutboundDeliveryFinalAnswer;
    items: OutboundDeliveryItem[];
  }): Promise<{ created: boolean; delivery: OutboundDelivery }>;
  getDelivery(id: OutboundDeliveryId): Promise<OutboundDelivery | null>;
  claimDueDeliveryItems(input: {
    appId?: OutboundDelivery['appId'];
    profileId?: string;
    now: string;
    claimerId: string;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedOutboundDeliveryItem[]>;
  resolveDeliveryDestination(input: {
    appId: OutboundDelivery['appId'];
    conversationId: OutboundDelivery['conversationId'];
    threadId?: OutboundDelivery['threadId'];
  }): Promise<OutboundDeliveryResolvedDestination | null>;
  markDeliveryItemSent(input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    claimToken: string;
    receipt: OutboundDeliveryReceipt;
  }): Promise<{ applied: boolean; delivery: OutboundDelivery | null }>;
  markDeliveryItemFailed(input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    claimToken: string;
    error: string;
    failedAt: string;
    maxAttempts: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  }): Promise<{ applied: boolean; delivery: OutboundDelivery | null }>;
  markDeliveryItemPartiallyDelivered(input: {
    deliveryId: OutboundDeliveryId;
    itemId: OutboundDeliveryItemId;
    claimToken: string;
    error: string;
    partialAt: string;
    deliveredParts?: number;
    totalParts?: number;
    retryTail?: {
      canonicalText: string;
      providerPayload?: unknown;
    };
  }): Promise<{ applied: boolean; delivery: OutboundDelivery | null }>;
  listReceiptsForItem(
    itemId: OutboundDeliveryItemId,
  ): Promise<OutboundDeliveryReceipt[]>;
  getReceipt(
    id: OutboundDeliveryReceiptId,
  ): Promise<OutboundDeliveryReceipt | null>;
}

export interface ToolCatalogRepository {
  getTool(id: ToolId): Promise<ToolCatalogItem | null>;
  listTools(input: {
    appId: AppId;
    statuses?: ToolCatalogItem['status'][];
  }): Promise<ToolCatalogItem[]>;
  saveTool(item: ToolCatalogItem): Promise<void>;
  saveAgentToolBinding(binding: AgentToolBinding): Promise<void>;
  disableAgentToolBinding(input: {
    appId: AppId;
    agentId: AgentId;
    toolId: ToolId;
    updatedAt: string;
  }): Promise<AgentToolBinding | null>;
  listAgentToolBindings(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentToolBinding[]>;
  listAgentToolBindingsForAgents(input: {
    appId: AppId;
    agentIds: readonly AgentId[];
  }): Promise<AgentToolBinding[]>;
}

export interface SkillCatalogRepository {
  getSkill(id: SkillId): Promise<SkillCatalogItem | null>;
  getSkillByContentHash?(input: {
    appId: AppId;
    contentHash: string;
    agentId?: AgentId | null;
    statuses?: SkillCatalogItem['status'][];
  }): Promise<SkillCatalogItem | null>;
  listSkills(input: {
    appId: AppId;
    agentId?: AgentId;
    statuses?: SkillCatalogItem['status'][];
  }): Promise<SkillCatalogItem[]>;
  saveSkill(item: SkillCatalogItem): Promise<void>;
  saveAgentSkillBinding(binding: AgentSkillBinding): Promise<void>;
  disableAgentSkillBinding(input: {
    appId: AppId;
    agentId: AgentId;
    skillId: SkillId;
    updatedAt: string;
  }): Promise<AgentSkillBinding | null>;
  listAgentSkillBindings(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentSkillBinding[]>;
  listAgentSkillBindingsForAgents(input: {
    appId: AppId;
    agentIds: readonly AgentId[];
  }): Promise<AgentSkillBinding[]>;
  listEnabledSkillsForAgent(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<SkillCatalogItem[]>;
}

export interface McpServerRepository {
  getServer(id: McpServerId): Promise<McpServerDefinition | null>;
  getServerByName(input: {
    appId: AppId;
    name: string;
  }): Promise<McpServerDefinition | null>;
  listServers(input: {
    appId: AppId;
    statuses?: McpServerDefinition['status'][];
    limit?: number;
    cursor?: string;
  }): Promise<McpServerDefinition[]>;
  saveServer(definition: McpServerDefinition): Promise<void>;
  transitionServerStatus(input: {
    appId: AppId;
    serverId: McpServerId;
    expectedStatus: McpServerDefinition['status'];
    next: McpServerDefinition;
  }): Promise<McpServerDefinition | null>;
  getVersion(id: McpServerVersionId): Promise<McpServerVersion | null>;
  listVersions(serverId: McpServerId): Promise<McpServerVersion[]>;
  saveVersion(version: McpServerVersion): Promise<void>;
  saveAgentBinding(binding: AgentMcpServerBinding): Promise<void>;
  disableAgentBinding(input: {
    appId: AppId;
    agentId: AgentId;
    serverId: McpServerId;
    updatedAt: string;
  }): Promise<AgentMcpServerBinding | null>;
  listAgentBindings(input: {
    appId: AppId;
    agentId: AgentId;
    limit?: number;
    cursor?: string;
  }): Promise<AgentMcpServerBinding[]>;
  listAgentBindingsForAgents(input: {
    appId: AppId;
    agentIds: readonly AgentId[];
    limitPerAgent?: number;
  }): Promise<AgentMcpServerBinding[]>;
  listMaterializedServersForAgent(input: {
    appId: AppId;
    agentId: AgentId;
    serverIds?: readonly McpServerId[];
  }): Promise<MaterializedMcpServer[]>;
  appendAuditEvent(event: McpServerAuditEvent): Promise<void>;
  listAuditEvents(input: {
    appId: AppId;
    serverId?: McpServerId;
    limit?: number;
    cursor?: string;
  }): Promise<McpServerAuditEvent[]>;
}

export interface PermissionRepository {
  savePolicy(policy: PermissionPolicy): Promise<void>;
  saveRule(rule: PermissionRule): Promise<void>;
  saveDecision(decision: PermissionDecision): Promise<void>;
  getDecision(id: PermissionDecisionId): Promise<PermissionDecision | null>;
}

export interface SandboxRepository {
  getSandboxProfile(id: SandboxProfileId): Promise<SandboxProfile | null>;
  saveSandboxProfile(profile: SandboxProfile): Promise<void>;
  getSandboxLease(id: SandboxLeaseId): Promise<SandboxLease | null>;
  saveSandboxLease(lease: SandboxLease): Promise<void>;
  saveWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void>;
  getWorkspaceSnapshot(
    id: WorkspaceSnapshotId,
  ): Promise<WorkspaceSnapshot | null>;
}
