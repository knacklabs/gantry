import { ApplicationError } from '../common/application-error.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentMcpServerBinding,
  McpServerDefinition,
  McpServerId,
  McpServerVersionId,
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
  AgentToolSource,
  ToolCatalogItem,
  ToolId,
} from '../../domain/tools/tools.js';
import {
  displayToolReference,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import {
  buildAgentToolAccessView,
  buildRequestableAdminToolAccess,
  PERMISSION_GATED_NATIVE_TOOLS,
  type AgentToolAccessView,
} from '../../shared/tool-access-view.js';
import { semanticCapabilityFromToolCatalogItem } from '../../shared/semantic-capabilities.js';
import { adminMcpToolNameFromFullName } from '../../shared/admin-mcp-tools.js';
import { nowIso } from '../../shared/time/datetime.js';

export interface CapabilityCatalogView {
  tools: ToolCatalogItem[];
  skills: SkillCatalogItem[];
  mcpServers: McpServerDefinition[];
}

export interface AgentCapabilitiesView {
  agentId: AgentId;
  sources: {
    skills: Array<{ id: string; version: string }>;
    mcpServers: Array<{ id: string; version: string }>;
    tools: Array<{ id: string; kind: string; version?: string }>;
  };
  capabilities: Array<{ id: string; version: string }>;
  toolAccess: AgentToolAccessView;
  updatedAt: string;
}

export interface AgentSourcesView {
  agentId: AgentId;
  sources: AgentCapabilitiesView['sources'];
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
      now: () => nowIso(),
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
    const [toolBindings, toolSources, skillBindings, mcpBindings] =
      await Promise.all([
        this.repositories.tools.listAgentToolBindings(input),
        this.listAgentToolSources(input),
        this.repositories.skills.listAgentSkillBindings(input),
        this.repositories.mcpServers.listAgentBindings({
          ...input,
          limit: 500,
        }),
      ]);
    const activeToolBindings = toolBindings.filter(
      (binding) => binding.status === 'active',
    );
    const selectedTools = await Promise.all(
      activeToolBindings.map((binding) =>
        this.repositories.tools.getTool(binding.toolId),
      ),
    );
    const configuredToolEntries = activeToolBindings.flatMap(
      (binding, index) => {
        const tool = selectedTools[index];
        if (tool?.appId && tool.appId !== input.appId) return [];
        return tool
          ? [
              {
                reference: displayToolReference({
                  toolId: binding.toolId,
                  tool,
                }),
                tool,
              },
            ]
          : [];
      },
    );
    const configuredTools = configuredToolEntries.map(
      (entry) => entry.reference,
    );
    const enabledAdminTools = selectedAdminToolNames(configuredTools);
    return {
      agentId: input.agentId,
      sources: {
        skills: skillBindings
          .filter((binding) => binding.status === 'active')
          .map((binding) => ({
            id: String(binding.skillId),
            version: 'approved',
          })),
        mcpServers: mcpBindings
          .filter((binding) => binding.status === 'active')
          .map((binding) => ({
            id: String(binding.serverId),
            version: String(binding.versionId),
          })),
        tools: readableToolSources(toolSources),
      },
      capabilities: configuredToolEntries.map((entry) =>
        toolReferenceToCapability(entry.reference, entry.tool),
      ),
      toolAccess: buildAgentToolAccessView({
        configuredTools,
        defaultTools: [],
        availableButGatedTools: PERMISSION_GATED_NATIVE_TOOLS.filter(
          (toolName) =>
            !configuredTools.some(
              (configured) =>
                configured === toolName ||
                configured.startsWith(`${toolName}(`),
            ),
        ),
        requestableAdminTools:
          buildRequestableAdminToolAccess(enabledAdminTools),
        source: 'Postgres agent_tool_bindings projected from settings.yaml',
      }),
      updatedAt: this.clock.now(),
    };
  }

  async replaceCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
    capabilities: Array<{ id: string; version: string }>;
  }): Promise<AgentCapabilitiesView> {
    const agent = await this.requireAgent(input.appId, input.agentId);
    if (agent.status !== 'active') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Agent is not active: ${input.agentId}`,
      );
    }
    const now = this.clock.now();
    const selectedToolReferences = unique(
      input.capabilities.map((capability) =>
        capabilitySelectionToToolReference(capability.id),
      ),
    );

    const capabilityToolIds = await Promise.all(
      selectedToolReferences.map(async (reference) => {
        const tool = await ensureAgentToolCatalogItem({
          repository: this.repositories.tools,
          appId: input.appId,
          reference,
          now,
        });
        return tool.id;
      }),
    );

    const [toolMap] = await Promise.all([
      this.requireSelectableTools(input.appId, capabilityToolIds),
    ]);

    const [toolBindings, toolSources, skillBindings, mcpBindings] =
      await Promise.all([
        this.repositories.tools.listAgentToolBindings(input),
        this.listAgentToolSources(input),
        this.repositories.skills.listAgentSkillBindings(input),
        this.repositories.mcpServers.listAgentBindings({
          appId: input.appId,
          agentId: input.agentId,
          limit: 500,
        }),
      ]);

    const toolBindingMap = new Map(
      toolBindings.map((binding) => [binding.toolId, binding]),
    );
    const toolSelection = new Set(capabilityToolIds);
    const nextToolBindings: AgentToolBinding[] = [
      ...toolBindings
        .filter(
          (binding) =>
            binding.status === 'active' && !toolSelection.has(binding.toolId),
        )
        .map((binding) => ({
          ...binding,
          status: 'disabled' as const,
          updatedAt: now,
        })),
      ...capabilityToolIds.map((toolId) => {
        const existing = toolBindingMap.get(toolId);
        return {
          id: `agent-tool-binding:${input.agentId}:${toolId}` as AgentToolBinding['id'],
          appId: input.appId,
          agentId: input.agentId,
          toolId,
          configVersionId: existing?.configVersionId,
          status: 'active' as const,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
      }),
    ];

    await this.repositories.agents.replaceAgentCapabilityBindings({
      appId: input.appId,
      agentId: input.agentId,
      toolBindings: nextToolBindings,
      skillBindings,
      mcpBindings,
      updatedAt: now,
    });

    const configuredToolEntries = capabilityToolIds.map((toolId) => {
      const tool = toolMap.get(toolId);
      if (!tool) {
        throw new ApplicationError('NOT_FOUND', `Tool not found: ${toolId}`);
      }
      return { reference: displayToolReference({ toolId, tool }), tool };
    });
    const configuredTools = configuredToolEntries.map(
      (entry) => entry.reference,
    );
    return {
      agentId: input.agentId,
      sources: {
        skills: skillBindings
          .filter((binding) => binding.status === 'active')
          .map((binding) => ({
            id: String(binding.skillId),
            version: 'approved',
          })),
        mcpServers: mcpBindings
          .filter((binding) => binding.status === 'active')
          .map((binding) => ({
            id: String(binding.serverId),
            version: String(binding.versionId),
          })),
        tools: readableToolSources(toolSources),
      },
      capabilities: configuredToolEntries.map((entry) =>
        toolReferenceToCapability(entry.reference, entry.tool),
      ),
      toolAccess: buildAgentToolAccessView({
        configuredTools,
        defaultTools: [],
        availableButGatedTools: PERMISSION_GATED_NATIVE_TOOLS.filter(
          (toolName) =>
            !configuredTools.some(
              (configured) =>
                configured === toolName ||
                configured.startsWith(`${toolName}(`),
            ),
        ),
        requestableAdminTools: buildRequestableAdminToolAccess(
          selectedAdminToolNames(configuredTools),
        ),
        source: 'Postgres agent_tool_bindings projected from settings.yaml',
      }),
      updatedAt: now,
    };
  }

  async getSources(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentSourcesView> {
    const view = await this.getCapabilities(input);
    return {
      agentId: view.agentId,
      sources: view.sources,
      updatedAt: view.updatedAt,
    };
  }

  async replaceSources(input: {
    appId: AppId;
    agentId: AgentId;
    sources: AgentCapabilitiesView['sources'];
  }): Promise<AgentSourcesView> {
    const agent = await this.requireAgent(input.appId, input.agentId);
    if (agent.status !== 'active') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Agent is not active: ${input.agentId}`,
      );
    }
    const now = this.clock.now();
    const sourceSkillIds = unique(
      input.sources.skills.map((source) => source.id as SkillId),
    );
    const sourceMcpServerIds = unique(
      input.sources.mcpServers.map((source) => source.id as McpServerId),
    );
    const sourceTools = uniqueToolSources(input.sources.tools, {
      appId: input.appId,
      agentId: input.agentId,
      now,
    });
    const [, mcpMap] = await Promise.all([
      this.requireApprovedSkills(input.appId, sourceSkillIds),
      this.requireApprovedMcpServers(input.appId, sourceMcpServerIds),
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
    const skillBindingMap = new Map(
      skillBindings.map((binding) => [binding.skillId, binding]),
    );
    const nextSkillBindings: AgentSkillBinding[] = sourceSkillIds.map(
      (skillId) => {
        const existing = skillBindingMap.get(skillId);
        return {
          id: `agent-skill-binding:${input.agentId}:${skillId}` as AgentSkillBinding['id'],
          appId: input.appId,
          agentId: input.agentId,
          skillId,
          configVersionId: existing?.configVersionId,
          status: 'active' as const,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
      },
    );
    const mcpBindingMap = new Map(
      mcpBindings.map((binding) => [binding.serverId, binding]),
    );
    const requestedMcpVersions = new Map(
      input.sources.mcpServers.map((source) => [
        source.id as McpServerId,
        source.version as McpServerVersionId,
      ]),
    );
    const mcpVersionByServerId = await this.resolveMcpSourceVersions({
      appId: input.appId,
      requestedVersions: requestedMcpVersions,
      serversById: mcpMap,
    });
    const nextMcpBindings: AgentMcpServerBinding[] = sourceMcpServerIds.map(
      (serverId) => {
        const existing = mcpBindingMap.get(serverId);
        return {
          id: `agent-mcp-binding:${input.agentId}:${serverId}` as AgentMcpServerBinding['id'],
          appId: input.appId,
          agentId: input.agentId,
          serverId,
          versionId: mcpVersionByServerId.get(serverId)!,
          status: 'active' as const,
          required: existing?.required ?? false,
          permissionPolicyIds: existing?.permissionPolicyIds ?? [],
          conversationId: existing?.conversationId,
          threadId: existing?.threadId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
      },
    );
    await this.repositories.agents.replaceAgentCapabilityBindings({
      appId: input.appId,
      agentId: input.agentId,
      toolBindings,
      skillBindings: nextSkillBindings,
      mcpBindings: nextMcpBindings,
      updatedAt: now,
    });
    await this.replaceAgentToolSources({
      appId: input.appId,
      agentId: input.agentId,
      sources: sourceTools,
      updatedAt: now,
    });
    return this.getSources(input);
  }

  private async resolveMcpSourceVersions(input: {
    appId: AppId;
    requestedVersions: Map<McpServerId, McpServerVersionId>;
    serversById: Map<McpServerId, McpServerDefinition>;
  }): Promise<Map<McpServerId, McpServerVersionId>> {
    const entries = await Promise.all(
      [...input.requestedVersions.entries()].map(
        async ([serverId, requestedVersionId]) => {
          const server = input.serversById.get(serverId);
          if (!server?.latestApprovedVersionId) {
            throw new ApplicationError(
              'INVALID_REQUEST',
              `MCP server ${serverId} has no approved version.`,
            );
          }
          const version =
            await this.repositories.mcpServers.getVersion(requestedVersionId);
          if (
            !version ||
            version.appId !== input.appId ||
            version.serverId !== serverId
          ) {
            throw new ApplicationError(
              'INVALID_REQUEST',
              `MCP server ${serverId} version ${requestedVersionId} is not approved for that source.`,
            );
          }
          return [serverId, requestedVersionId] as const;
        },
      ),
    );
    return new Map(entries);
  }

  private async listAgentToolSources(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentToolSource[]> {
    return this.repositories.tools.listAgentToolSources
      ? this.repositories.tools.listAgentToolSources(input)
      : [];
  }

  private async replaceAgentToolSources(input: {
    appId: AppId;
    agentId: AgentId;
    sources: AgentToolSource[];
    updatedAt: string;
  }): Promise<void> {
    if (!this.repositories.tools.replaceAgentToolSources) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Agent tool source repository is unavailable.',
      );
    }
    await this.repositories.tools.replaceAgentToolSources(input);
  }

  private async requireAgent(appId: AppId, agentId: AgentId) {
    const agent = await this.repositories.agents.getAgent(agentId);
    if (!agent || agent.appId !== appId) {
      throw new ApplicationError('NOT_FOUND', `Agent not found: ${agentId}`);
    }
    return agent;
  }

  private async requireSelectableTools(
    appId: AppId,
    toolIds: ToolId[],
  ): Promise<Map<ToolId, ToolCatalogItem>> {
    const tools = new Map<ToolId, ToolCatalogItem>();
    await Promise.all(
      toolIds.map(async (toolId) => {
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
        const readableRule = displayToolReference({ toolId, tool });
        const validation = validateReadableAgentToolRule(readableRule);
        if (!validation.ok) {
          throw new ApplicationError(
            'INVALID_REQUEST',
            `Tool is not selectable: ${readableRule}: ${validation.reason}`,
          );
        }
        tools.set(toolId, tool);
      }),
    );
    return tools;
  }

  private async requireApprovedSkills(
    appId: AppId,
    skillIds: SkillId[],
  ): Promise<Map<SkillId, SkillCatalogItem>> {
    const skills = new Map<SkillId, SkillCatalogItem>();
    await Promise.all(
      skillIds.map(async (skillId) => {
        const skill = await this.repositories.skills.getSkill(skillId);
        if (!skill || skill.appId !== appId) {
          throw new ApplicationError(
            'NOT_FOUND',
            `Skill not found: ${skillId}`,
          );
        }
        if (!isSkillUsableForBinding(skill)) {
          throw new ApplicationError(
            'INVALID_REQUEST',
            `Skill is not approved: ${skillId}`,
          );
        }
        skills.set(skillId, skill);
      }),
    );
    return skills;
  }

  private async requireApprovedMcpServers(
    appId: AppId,
    serverIds: McpServerId[],
  ): Promise<Map<McpServerId, McpServerDefinition>> {
    const servers = new Map<McpServerId, McpServerDefinition>();
    await Promise.all(
      serverIds.map(async (serverId) => {
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
      }),
    );
    return servers;
  }
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function capabilitySelectionToToolReference(capabilityId: string): string {
  const id = capabilityId.trim();
  if (id === 'browser.use') return 'Browser';
  if (id.startsWith('RunCommand(')) return id;
  return `capability:${id}`;
}

function toolReferenceToCapability(
  reference: string,
  tool?: ToolCatalogItem,
): {
  id: string;
  version: string;
} {
  if (reference === 'Browser') return { id: 'browser.use', version: 'builtin' };
  if (reference.startsWith('capability:')) {
    const semanticCapability = tool
      ? semanticCapabilityFromToolCatalogItem({
          name: tool.name,
          inputSchema: tool.inputSchema,
        })
      : undefined;
    return {
      id: reference.slice('capability:'.length),
      version: semanticCapability?.version ?? 'builtin',
    };
  }
  return { id: reference, version: 'builtin' };
}

function selectedAdminToolNames(tools: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = adminMcpToolNameFromFullName(tool);
    if (name) names.add(name);
  }
  return names;
}

function readableToolSources(
  sources: readonly AgentToolSource[],
): AgentCapabilitiesView['sources']['tools'] {
  return sources
    .filter((source) => source.status === 'active')
    .map((source) => ({
      id: source.sourceId,
      kind: source.kind,
      ...(source.version && source.version !== source.kind
        ? { version: source.version }
        : {}),
    }));
}

function uniqueToolSources(
  sources: AgentCapabilitiesView['sources']['tools'],
  input: {
    appId: AppId;
    agentId: AgentId;
    now: string;
  },
): AgentToolSource[] {
  const byKey = new Map<string, AgentToolSource>();
  for (const source of sources) {
    const version = source.version ?? source.kind;
    const key = `${source.kind}:${source.id}:${version}`;
    byKey.set(key, {
      id: `agent-tool-source:${input.agentId}:${source.kind}:${source.id}:${version}` as AgentToolSource['id'],
      appId: input.appId,
      agentId: input.agentId,
      sourceId: source.id,
      kind: source.kind as AgentToolSource['kind'],
      version,
      status: 'active',
      createdAt: input.now as never,
      updatedAt: input.now as never,
    });
  }
  return [...byKey.values()];
}
