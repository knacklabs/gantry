import type { Agent } from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type { AgentRepository } from '../../../../domain/ports/repositories.js';
import type { AgentMcpServerBinding } from '../../../../domain/mcp/mcp-servers.js';
import type { AgentSkillBinding } from '../../../../domain/skills/skills.js';
import type { AgentToolBinding, AgentToolSource } from '../../../../domain/tools/tools.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresAgentRepository implements AgentRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getAgent(id: Agent['id']): Promise<Agent | null>;
    listAgents(appId: App['id']): Promise<Agent[]>;
    saveAgent(agent: Agent): Promise<void>;
    replaceAgentCapabilityBindings(input: {
        appId: Agent['appId'];
        agentId: Agent['id'];
        toolBindings: AgentToolBinding[];
        skillBindings: AgentSkillBinding[];
        mcpBindings: AgentMcpServerBinding[];
        updatedAt: string;
    }): Promise<void>;
    replaceAgentAccess(input: {
        appId: Agent['appId'];
        agentId: Agent['id'];
        toolBindings: AgentToolBinding[];
        skillBindings: AgentSkillBinding[];
        mcpBindings: AgentMcpServerBinding[];
        toolSources: AgentToolSource[];
        updatedAt: string;
    }): Promise<void>;
    private writeAgentCapabilityBindings;
    private writeAgentToolSources;
    disableAgent(input: {
        appId: Agent['appId'];
        agentId: Agent['id'];
        updatedAt: string;
    }): Promise<Agent | null>;
}
