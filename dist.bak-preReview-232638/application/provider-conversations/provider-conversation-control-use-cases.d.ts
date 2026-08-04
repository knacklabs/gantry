import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { ConversationInstall, ConversationInstallMemoryScope, ProviderAccount, ProviderAccountId, ProviderId } from '../../domain/provider/provider.js';
import type { ConversationId, ConversationThreadId } from '../../domain/conversation/conversation.js';
import type { MemorySubject, MemorySubjectRoute } from '../../domain/memory/memory.js';
import type { AgentRepository, ProviderAccountRepository, ConversationRepository } from '../../domain/ports/repositories.js';
import type { PermissionPolicyId } from '../../domain/permissions/permissions.js';
import type { WorkspaceSnapshotId } from '../../domain/sandbox/sandbox.js';
import type { ExternalRef } from '../../shared/ids/branded-id.js';
import type { Clock } from '../common/clock.js';
import type { IdGenerator } from '../common/id-generator.js';
import type { ProviderCatalogPort } from './provider-catalog-ports.js';
export interface ProviderAccountPatch {
    label?: string;
    status?: ProviderAccount['status'] | 'inactive' | 'archived';
    enabled?: boolean;
    config?: Record<string, unknown>;
    externalInstallationRef?: ExternalRef<'provider_account'> | null;
    runtimeSecretRefs?: Record<string, string>;
}
export interface ConversationInstallPatch {
    providerAccountId?: ProviderAccountId;
    threadId?: ConversationThreadId;
    displayName?: string;
    memoryScope?: ConversationInstallMemoryScope;
    memorySubject?: MemorySubject;
    routeConfig?: MemorySubjectRoute;
    workspaceSnapshotId?: WorkspaceSnapshotId | null;
    permissionPolicyIds?: PermissionPolicyId[];
    status?: ConversationInstall['status'];
}
export interface DiscoveredConversation {
    externalId: string;
    title?: string;
    kind: 'direct' | 'group' | 'channel' | 'service' | 'web';
    status?: 'active' | 'archived' | 'disabled';
    externalRef?: ExternalRef<'conversation'>;
}
export interface ProviderConversationDiscoveryPort {
    discover(input: {
        providerAccount: ProviderAccount;
        query?: string;
        includeArchived?: boolean;
        limit?: number;
        providerMetadata?: Record<string, unknown>;
    }): Promise<DiscoveredConversation[]>;
}
export declare class ProviderAccountControlService {
    private readonly deps;
    constructor(deps: {
        agents: AgentRepository;
        providerAccounts: ProviderAccountRepository;
        providers: ProviderCatalogPort;
        ids: IdGenerator;
        clock: Clock;
    });
    list(appId: AppId): Promise<ProviderAccount[]>;
    get(input: {
        appId: AppId;
        providerAccountId: ProviderAccountId;
    }): Promise<ProviderAccount>;
    create(input: {
        appId: AppId;
        agentId: AgentId;
        providerId: ProviderId;
        label: string;
        config?: Record<string, unknown>;
        externalInstallationRef?: ExternalRef<'provider_account'>;
        runtimeSecretRefs?: Record<string, string>;
        enabled?: boolean;
    }): Promise<ProviderAccount>;
    update(input: {
        appId: AppId;
        providerAccountId: ProviderAccountId;
        patch: ProviderAccountPatch;
    }): Promise<ProviderAccount>;
    disable(input: {
        appId: AppId;
        providerAccountId: ProviderAccountId;
    }): Promise<ProviderAccount>;
}
export declare class DiscoverProviderConversationsService {
    private readonly deps;
    constructor(deps: {
        providerAccounts: ProviderAccountRepository;
        conversations: ConversationRepository;
        discovery: ProviderConversationDiscoveryPort;
        ids: IdGenerator;
        clock: Clock;
    });
    execute(input: {
        appId: AppId;
        providerAccountId: ProviderAccountId;
        query?: string;
        includeArchived?: boolean;
        limit?: number;
        providerMetadata?: Record<string, unknown>;
    }): Promise<{
        id: ConversationId;
        appId: AppId;
        providerAccountId: ProviderAccountId;
        externalRef: ExternalRef<"conversation">;
        kind: "direct" | "group" | "channel" | "service" | "web";
        title: string | undefined;
        status: "active" | "disabled" | "archived";
        createdAt: string;
        updatedAt: string;
    }[]>;
}
export declare class ConversationInstallControlService {
    private readonly deps;
    constructor(deps: {
        agents: AgentRepository;
        providerAccounts: ProviderAccountRepository;
        conversations: ConversationRepository;
        ids: IdGenerator;
        clock: Clock;
    });
    list(input: {
        appId: AppId;
        agentId: AgentId;
    }): Promise<ConversationInstall[]>;
    enable(input: {
        appId: AppId;
        agentId: AgentId;
        conversationId: ConversationId;
        patch: ConversationInstallPatch;
    }): Promise<ConversationInstall>;
    update(input: {
        appId: AppId;
        agentId: AgentId;
        conversationId: ConversationId;
        patch: ConversationInstallPatch;
    }): Promise<ConversationInstall>;
    disable(input: {
        appId: AppId;
        agentId: AgentId;
        conversationId: ConversationId;
        threadId?: ConversationThreadId;
    }): Promise<ConversationInstall>;
    private upsert;
    private assertAgent;
}
