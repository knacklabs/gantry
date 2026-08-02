import type { GroupProcessingDeps } from './group-processing-types.js';
import { type ConfiguredAgentToolPolicy } from './configured-agent-tools.js';
import { type SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
export declare function memoryScopeForConversationKind(conversationKind?: string): 'user' | 'group';
export declare function resolveTurnToolPolicy(deps: Pick<GroupProcessingDeps, 'getToolRepository' | 'getSkillRepository'>, turnContext?: {
    appId: string;
    agentId: string;
} | null): Promise<ConfiguredAgentToolPolicy>;
export declare function resolveTurnSelectedSkillContext(deps: Pick<GroupProcessingDeps, 'getSkillRepository'>, turnContext?: {
    appId: string;
    agentId: string;
} | null): Promise<{
    ids?: string[];
    displays?: string[];
}>;
export declare function resolveTurnSelectedMcpServerIds(deps: Pick<GroupProcessingDeps, 'getMcpServerRepository'>, turnContext?: {
    appId: string;
    agentId: string;
} | null): Promise<string[] | undefined>;
export declare function resolveTurnPromptCapabilityCatalog(deps: Pick<GroupProcessingDeps, 'getSkillRepository' | 'getMcpServerRepository'>, scope: {
    appId: string;
    agentId: string;
}, readySemanticCapabilities: readonly SemanticCapabilityDefinition[]): Promise<import("../application/agents/agent-prompt-capability-catalog.js").AgentPromptCapabilityCatalog>;
export declare function resolveTurnSemanticCapabilities(deps: Pick<GroupProcessingDeps, 'getToolRepository' | 'getSkillRepository'>, turnContext?: {
    appId: string;
    agentId: string;
} | null): Promise<SemanticCapabilityDefinition[]>;
