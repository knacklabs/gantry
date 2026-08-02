import type { GroupProcessingDeps } from './group-processing-types.js';
export declare function resolveGroupAgentAccessContext(input: {
    deps: GroupProcessingDeps;
    turnContext?: {
        appId: string;
        agentId: string;
    } | null;
    catalogScope: {
        appId: string;
        agentId: string;
    };
    agentFolder: string;
}): Promise<{
    configuredToolPolicy: import("./configured-agent-tools.js").ConfiguredAgentToolPolicy;
    selectedSkillContext: {
        ids?: string[];
        displays?: string[];
    };
    semanticCapabilities: import("../shared/semantic-capabilities.js").SemanticCapabilityDefinition[];
    attachedMcpSourceIds: string[] | undefined;
    capabilityCatalog: import("../application/agents/agent-prompt-capability-catalog.js").AgentPromptCapabilityCatalog;
    currentAccessFingerprint: string;
}>;
