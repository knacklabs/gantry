import { ApplicationError } from '../common/application-error.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentMcpServerBinding,
  McpServerDefinition,
  McpServerId,
} from '../../domain/mcp/mcp-servers.js';
import { isMcpServerApproved } from '../../domain/mcp/mcp-servers.js';
import type {
  AgentRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
  SkillId,
} from '../../domain/skills/skills.js';
import { isSkillUsableForBinding } from '../../domain/skills/skills.js';
import type {
  AgentToolBinding,
  ToolCatalogItem,
  ToolId,
} from '../../domain/tools/tools.js';

export interface CapabilityCatalogView {
  tools: ToolCatalogItem[];
  skills: SkillCatalogItem[];
  mcpServers: McpServerDefinition[];
}

export interface AgentCapabilitiesView {
  agentId: AgentId;
  selectedToolIds: ToolId[];
  selectedSkillIds: SkillId[];
  selectedMcpServerIds: McpServerId[];
  updatedAt: string;
}

export class AgentCapabilityAdministrationService {
  constructor(
    private readonly repositories: {
      agents: AgentRepository;
      tools: ToolCatalogRepository;
      skills: SkillCatalogRepository;
      mcpServers: McpServerRepository;
    },
    private readonly clock: { now(): string } = {
      now: () => new Date().toISOString(),
    },
  ) {}

  async listCatalog(appId: AppId): Promise<CapabilityCatalogView> {
    const [tools, skills, mcpServers] = await Promise.all([
      this.repositories.tools.listTools({ appId, statuses: ['active'] }),
      this.repositories.skills.listSkills({ appId, statuses: ['approved'] }),
      this.repositories.mcpServers.listServers({
        appId,
        statuses: ['approved'],
        limit: 500,
      }),
    ]);
    return {
      tools: tools.filter((tool) => tool.selectable),
      skills,
      mcpServers,
    };
  }

  async getCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentCapabilitiesView> {
    await this.requireAgent(input.appId, input.agentId);
    const [toolBindings, skillBindings, mcpBindings] = await Promise.all([
      this.repositories.tools.listAgentToolBindings(input),
      this.repositories.skills.listAgentSkillBindings(input),
      this.repositories.mcpServers.listAgentBindings({
        ...input,
        limit: 500,
      }),
    ]);
    return {
      agentId: input.agentId,
      selectedToolIds: toolBindings
        .filter((binding) => binding.status === 'active')
        .map((binding) => binding.toolId),
      selectedSkillIds: skillBindings
        .filter((binding) => binding.status === 'active')
        .map((binding) => binding.skillId),
      selectedMcpServerIds: mcpBindings
        .filter((binding) => binding.status === 'active')
        .map((binding) => binding.serverId),
      updatedAt: this.clock.now(),
    };
  }

  async replaceCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
    selectedToolIds: ToolId[];
    selectedSkillIds: SkillId[];
    selectedMcpServerIds: McpServerId[];
  }): Promise<AgentCapabilitiesView> {
    await this.requireAgent(input.appId, input.agentId);
    const now = this.clock.now();
    const selectedToolIds = unique(input.selectedToolIds);
    const selectedSkillIds = unique(input.selectedSkillIds);
    const selectedMcpServerIds = unique(input.selectedMcpServerIds);

    const [, , mcpMap] = await Promise.all([
      this.requireSelectableTools(input.appId, selectedToolIds),
      this.requireApprovedSkills(input.appId, selectedSkillIds),
      this.requireApprovedMcpServers(input.appId, selectedMcpServerIds),
    ]);

    const [toolBindings, skillBindings, mcpBindings] = await Promise.all([
      this.repositories.tools.listAgentToolBindings(input),
      this.repositories.skills.listAgentSkillBindings(input),
      this.repositories.mcpServers.listAgentBindings({
        appId: input.appId,
        agentId: input.agentId,
        limit: 500,
      }),
    ]);

    const toolSelection = new Set(selectedToolIds);
    await Promise.all(
      toolBindings
        .filter(
          (binding) =>
            binding.status === 'active' && !toolSelection.has(binding.toolId),
        )
        .map((binding) =>
          this.repositories.tools.disableAgentToolBinding({
            appId: input.appId,
            agentId: input.agentId,
            toolId: binding.toolId,
            updatedAt: now,
          }),
        ),
    );
    for (const toolId of selectedToolIds) {
      const existing = toolBindings.find(
        (binding) => binding.toolId === toolId,
      );
      await this.repositories.tools.saveAgentToolBinding({
        id: `agent-tool-binding:${input.agentId}:${toolId}` as AgentToolBinding['id'],
        appId: input.appId,
        agentId: input.agentId,
        toolId,
        configVersionId: existing?.configVersionId,
        status: 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }

    const skillSelection = new Set(selectedSkillIds);
    await Promise.all(
      skillBindings
        .filter(
          (binding) =>
            binding.status === 'active' && !skillSelection.has(binding.skillId),
        )
        .map((binding) =>
          this.repositories.skills.disableAgentSkillBinding({
            appId: input.appId,
            agentId: input.agentId,
            skillId: binding.skillId,
            updatedAt: now,
          }),
        ),
    );
    for (const skillId of selectedSkillIds) {
      const existing = skillBindings.find(
        (binding) => binding.skillId === skillId,
      );
      await this.repositories.skills.saveAgentSkillBinding({
        id: `agent-skill-binding:${input.agentId}:${skillId}` as AgentSkillBinding['id'],
        appId: input.appId,
        agentId: input.agentId,
        skillId,
        configVersionId: existing?.configVersionId,
        status: 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }

    const mcpSelection = new Set(selectedMcpServerIds);
    await Promise.all(
      mcpBindings
        .filter(
          (binding) =>
            binding.status === 'active' && !mcpSelection.has(binding.serverId),
        )
        .map((binding) =>
          this.repositories.mcpServers.disableAgentBinding({
            appId: input.appId,
            agentId: input.agentId,
            serverId: binding.serverId,
            updatedAt: now,
          }),
        ),
    );
    for (const serverId of selectedMcpServerIds) {
      const server = mcpMap.get(serverId);
      if (!server?.latestApprovedVersionId) continue;
      const existing = mcpBindings.find(
        (binding) => binding.serverId === serverId,
      );
      await this.repositories.mcpServers.saveAgentBinding({
        id: `agent-mcp-binding:${input.agentId}:${serverId}` as AgentMcpServerBinding['id'],
        appId: input.appId,
        agentId: input.agentId,
        serverId,
        versionId: server.latestApprovedVersionId,
        status: 'active',
        required: existing?.required ?? false,
        permissionPolicyIds: existing?.permissionPolicyIds ?? [],
        conversationId: existing?.conversationId,
        threadId: existing?.threadId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }

    return {
      agentId: input.agentId,
      selectedToolIds,
      selectedSkillIds,
      selectedMcpServerIds,
      updatedAt: now,
    };
  }

  private async requireAgent(appId: AppId, agentId: AgentId): Promise<void> {
    const agent = await this.repositories.agents.getAgent(agentId);
    if (!agent || agent.appId !== appId) {
      throw new ApplicationError('NOT_FOUND', `Agent not found: ${agentId}`);
    }
  }

  private async requireSelectableTools(
    appId: AppId,
    toolIds: ToolId[],
  ): Promise<Map<ToolId, ToolCatalogItem>> {
    const tools = new Map<ToolId, ToolCatalogItem>();
    for (const toolId of toolIds) {
      const tool = await this.repositories.tools.getTool(toolId);
      if (!tool || tool.appId !== appId) {
        throw new ApplicationError('NOT_FOUND', `Tool not found: ${toolId}`);
      }
      if (tool.status !== 'active' || !tool.selectable) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `Tool is not selectable: ${toolId}`,
        );
      }
      tools.set(toolId, tool);
    }
    return tools;
  }

  private async requireApprovedSkills(
    appId: AppId,
    skillIds: SkillId[],
  ): Promise<Map<SkillId, SkillCatalogItem>> {
    const skills = new Map<SkillId, SkillCatalogItem>();
    for (const skillId of skillIds) {
      const skill = await this.repositories.skills.getSkill(skillId);
      if (!skill || skill.appId !== appId) {
        throw new ApplicationError('NOT_FOUND', `Skill not found: ${skillId}`);
      }
      if (!isSkillUsableForBinding(skill)) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `Skill is not approved: ${skillId}`,
        );
      }
      skills.set(skillId, skill);
    }
    return skills;
  }

  private async requireApprovedMcpServers(
    appId: AppId,
    serverIds: McpServerId[],
  ): Promise<Map<McpServerId, McpServerDefinition>> {
    const servers = new Map<McpServerId, McpServerDefinition>();
    for (const serverId of serverIds) {
      const server = await this.repositories.mcpServers.getServer(serverId);
      if (!server || server.appId !== appId) {
        throw new ApplicationError(
          'NOT_FOUND',
          `MCP server not found: ${serverId}`,
        );
      }
      if (!isMcpServerApproved(server)) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `MCP server is not approved: ${serverId}`,
        );
      }
      servers.set(serverId, server);
    }
    return servers;
  }
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
