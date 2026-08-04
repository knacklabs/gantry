import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type { AgentSkillBinding, SkillCatalogItem } from '../../domain/skills/skills.js';
import type { AgentToolBinding, AgentToolSource } from '../../domain/tools/tools.js';
import type { RuntimeConfiguredAgentCapability, RuntimeConfiguredAgentSources, RuntimeConfiguredBinding, RuntimeConfiguredConversation } from './runtime-settings-types.js';
export declare function activeCapabilities(toolBindings: AgentToolBinding[]): RuntimeConfiguredAgentCapability[];
export declare function activeSources(skillBindings: AgentSkillBinding[], mcpBindings: AgentMcpServerBinding[], skillCatalogById: Map<unknown, {
    name: string;
}>, toolSources?: AgentToolSource[]): RuntimeConfiguredAgentSources;
export declare function readableActiveCapabilities(toolBindings: AgentToolBinding[], toolCatalogById: Map<unknown, {
    name: string;
    inputSchema?: unknown;
}>, _options?: {
    skillBindings?: AgentSkillBinding[];
    skillCatalogById?: Map<unknown, SkillCatalogItem>;
}): RuntimeConfiguredAgentCapability[];
export declare function configuredConversationId(input: {
    providerConnectionId: string;
    externalId: string;
    conversations: Record<string, RuntimeConfiguredConversation>;
}): string | undefined;
export declare function dedupeConfiguredConversation(input: {
    canonicalId: string;
    providerConnectionId: string;
    externalId: string;
    conversations: Record<string, RuntimeConfiguredConversation>;
    bindings: Record<string, RuntimeConfiguredBinding>;
}): void;
export declare function configuredBindingId(input: {
    agent: string;
    conversationId: string;
    bindings: Record<string, RuntimeConfiguredBinding>;
}): string | undefined;
export declare function stableBindingId(jid: string, existing: Record<string, unknown>): string;
export declare function stableSettingsId(seed: string, existing: Record<string, unknown>): string;
