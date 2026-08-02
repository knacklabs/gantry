import type { AgentId } from '../../domain/agent/agent.js';
import { agentIdForFolder, folderForAgentId } from '../../domain/agent/agent-folder-id.js';
import type { AppId } from '../../domain/app/app.js';
import type { ConversationId } from '../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../domain/memory/memory.js';
import type { ConversationApprover, ProviderId } from '../../domain/provider/provider.js';
import type { McpServerRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { ConfiguredRoutingBinding, SettingsChangeClassification, StoredAgentBinding } from './desired-state-service-types.js';
import type { RuntimeConfiguredAgent, RuntimeConfiguredBinding, RuntimeConfiguredConversation, RuntimeSettings } from './runtime-settings-types.js';
import type { AgentConfig } from '../../domain/types.js';
export { agentIdForFolder, folderForAgentId };
export declare function configuredRoutingBindingsByAgent(settings: RuntimeSettings, existingRoutes?: Record<string, StoredAgentBinding>): Map<string, ConfiguredRoutingBinding[]>;
export declare function configuredAgentConfig(binding: Pick<ConfiguredRoutingBinding, 'model' | 'permissionMode'>, agent?: Pick<RuntimeConfiguredAgent, 'persona' | 'relationshipMode'>): AgentConfig | undefined;
export declare function configuredRoutingBindings(settings: RuntimeSettings, existingRoutes?: Record<string, StoredAgentBinding>): ConfiguredRoutingBinding[];
export declare function memorySubjectForConfiguredBinding(input: {
    appId: AppId;
    agentId: AgentId;
    memoryScope: RuntimeConfiguredBinding['memoryScope'];
    conversation: RuntimeConfiguredConversation;
    conversationId: ConversationId;
}): MemorySubject;
export declare function errorMessage(err: unknown): string;
export declare function listDbOnlyGroupJids(input: {
    groups: Record<string, StoredAgentBinding>;
    chats: Array<{
        jid: string;
        is_group?: number;
    }>;
    configuredJids: Set<string>;
}): string[];
export declare function normalizeUserIds(userIds: string[]): string[];
export declare function isValidExternalUserId(value: string): boolean;
export declare function isInternalProviderAccount(providerId: ProviderId): boolean;
export declare function normalizeRuntimeSecretRefs(input: {
    refs: Record<string, string>;
    pathPrefix: string;
}): Record<string, string>;
export declare function classifySettingsChanges(before: RuntimeSettings, after: RuntimeSettings): SettingsChangeClassification;
export declare function hasAnyCapability(agent: RuntimeConfiguredAgent): boolean;
export declare function groupByAgentId<T extends {
    agentId: AgentId;
}>(rows: readonly T[]): Map<AgentId, T[]>;
export declare function groupByConversationId(rows: readonly ConversationApprover[]): Map<ConversationId, ConversationApprover[]>;
export declare function storedConversationKey(providerConnectionId: string, externalConversationId: string): string;
export declare function loadToolsById(repository: ToolCatalogRepository, toolIds: readonly string[]): Promise<Map<string, Awaited<ReturnType<ToolCatalogRepository['getTool']>>>>;
export declare function loadMcpServersById(repository: McpServerRepository, serverIds: readonly string[]): Promise<Map<string, Awaited<ReturnType<McpServerRepository['getServer']>>>>;
