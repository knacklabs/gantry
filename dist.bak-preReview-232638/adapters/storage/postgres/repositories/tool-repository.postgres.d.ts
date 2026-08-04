import type { ToolCatalogRepository } from '../../../../domain/ports/repositories.js';
import type { AgentToolBinding, AgentToolSource, ToolCatalogItem } from '../../../../domain/tools/tools.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresToolCatalogRepository implements ToolCatalogRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getTool(id: ToolCatalogItem['id']): Promise<ToolCatalogItem | null>;
    listTools(input: {
        appId: ToolCatalogItem['appId'];
        statuses?: ToolCatalogItem['status'][];
    }): Promise<ToolCatalogItem[]>;
    saveTool(item: ToolCatalogItem): Promise<void>;
    saveAgentToolBinding(binding: AgentToolBinding): Promise<void>;
    disableAgentToolBinding(input: {
        appId: AgentToolBinding['appId'];
        agentId: AgentToolBinding['agentId'];
        toolId: AgentToolBinding['toolId'];
        updatedAt: string;
    }): Promise<AgentToolBinding | null>;
    listAgentToolBindings(input: {
        appId: AgentToolBinding['appId'];
        agentId: AgentToolBinding['agentId'];
    }): Promise<AgentToolBinding[]>;
    listAgentToolBindingsForAgents(input: {
        appId: AgentToolBinding['appId'];
        agentIds: readonly AgentToolBinding['agentId'][];
    }): Promise<AgentToolBinding[]>;
    replaceAgentToolSources(input: {
        appId: AgentToolSource['appId'];
        agentId: AgentToolSource['agentId'];
        sources: AgentToolSource[];
        updatedAt: string;
    }): Promise<void>;
    listAgentToolSources(input: {
        appId: AgentToolSource['appId'];
        agentId: AgentToolSource['agentId'];
    }): Promise<AgentToolSource[]>;
    listAgentToolSourcesForAgents(input: {
        appId: AgentToolSource['appId'];
        agentIds: readonly AgentToolSource['agentId'][];
    }): Promise<AgentToolSource[]>;
    private listAgentToolBindingRows;
    private listAgentToolSourceRows;
    private mapTool;
    private mapBinding;
    private mapSource;
}
