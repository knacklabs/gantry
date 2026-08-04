import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
export interface AppliedMcpSourceBinding {
    binding: AgentMcpServerBinding;
    previous?: AgentMcpServerBinding;
}
export declare function ensureMcpSourceBindingsForRules(input: {
    appId: AppId;
    agentId: AgentId;
    mcpServerRepository?: McpServerRepository;
    rules: readonly string[];
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
    timestamp: string;
}): Promise<AppliedMcpSourceBinding[]>;
export declare function rollbackAppliedMcpSourceBindings(input: {
    appId: AppId;
    agentId: AgentId;
    mcpServerRepository?: McpServerRepository;
    applied: readonly AppliedMcpSourceBinding[];
    timestamp: string;
}): Promise<void>;
