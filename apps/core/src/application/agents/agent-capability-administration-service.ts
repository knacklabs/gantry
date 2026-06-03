import { ApplicationError } from '../common/application-error.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentMcpServerBinding,
  McpServerDefinition,
  McpServerId,
} from '../../domain/mcp/mcp-servers.js';
import { isMcpServerActive } from '../../domain/mcp/mcp-servers.js';
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
import {
  formatSkillMaterializationCollision,
  skillMaterializationCollisions,
} from '../../domain/skills/skill-identity.js';
import type {
  AgentToolBinding,
  AgentToolSource,
  ToolCatalogItem,
  ToolId,
} from '../../domain/tools/tools.js';
import {
  displayToolReference,
  isGantryFacadeExactToolRule,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import { validateDurableAccessRule } from '../../shared/durable-access-policy.js';
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import {
  buildConfiguredAgentToolAccess,
  buildRequestableAdminToolAccess,
  type AgentToolAccessView,
} from '../../shared/tool-access-view.js';
import {
  adminMcpToolNameFromFullName,
  isAdminMcpToolFullName,
} from '../../shared/admin-mcp-tools.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  buildSelectedCapabilities,
  canonicalToolReferenceForView,
  skillActionDefinitionsForAgent,
  skillActionDefinitionsForBindings,
} from './agent-capability-skill-actions.js';
import {
  buildAgentSources,
  readableSkillSources,
  type ReadableSkillSource,
  type ReadableToolSource,
} from './agent-source-views.js';
import { replaceAgentAccessDocument } from './agent-access-document-replacement.js';
import { nextMcpSourceBindings } from './agent-mcp-source-bindings.js';
import {
  summarizeAgentAccess,
  type AgentAccessSummary,
} from './agent-access-summary.js';

export interface CapabilityCatalogView {
  tools: ToolCatalogItem[];
  skills: SkillCatalogItem[];
  mcpServers: McpServerDefinition[];
}

export interface AgentCapabilitiesView {
  agentId: AgentId;
  sources: {
    skills: ReadableSkillSource[];
    mcpServers: Array<{ id: string; tools?: string[] }>;
    tools: ReadableToolSource[];
  };
  capabilities: Array<{ id: string; version: string }>;
  toolAccess: AgentToolAccessView;
  summary: AgentAccessSummary;
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
      this.repositories.skills.listSkills({ appId, statuses: ['installed'] }),
      this.repositories.mcpServers.listServers({
        appId,
        statuses: ['active'],
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
    const [selectedTools, configuredSkillSources] = await Promise.all([
      Promise.all(
        activeToolBindings.map((binding) =>
          this.repositories.tools.getTool(binding.toolId),
        ),
      ),
      readableSkillSources({
        skillBindings,
        repository: this.repositories.skills,
      }),
    ]);
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
    const semanticCapabilityDefinitions =
      await skillActionDefinitionsForBindings({
        appId: input.appId,
        skillBindings,
        skillRepository: this.repositories.skills,
      });
    const configuredTools = configuredToolEntries.flatMap((entry) =>
      canonicalToolReferenceForView(entry.reference, {
        semanticCapabilityDefinitions,
      }),
    );
    const enabledAdminTools = selectedAdminToolNames(configuredTools);
    const sources = buildAgentSources({
      configuredSkillSources,
      mcpBindings,
      toolSources,
    });
    const capabilities = buildSelectedCapabilities(
      configuredToolEntries,
      semanticCapabilityDefinitions,
    );
    const toolAccess = buildConfiguredAgentToolAccess(
      configuredTools,
      buildRequestableAdminToolAccess(enabledAdminTools),
    );
    return {
      agentId: input.agentId,
      sources,
      capabilities,
      toolAccess,
      summary: summarizeAgentAccess({
        sources,
        capabilities,
        toolAccess,
        toolBindings,
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
    const semanticCapabilityDefinitions = await skillActionDefinitionsForAgent({
      appId: input.appId,
      agentId: input.agentId,
      skillRepository: this.repositories.skills,
    });
    const selectedToolReferences = resolveSelectedToolReferences(
      input.capabilities,
      semanticCapabilityDefinitions,
    );

    const capabilityToolIds = await Promise.all(
      selectedToolReferences.map(async (reference) => {
        const tool = await ensureAgentToolCatalogItem({
          repository: this.repositories.tools,
          appId: input.appId,
          reference,
          now,
          semanticCapabilityDefinitions,
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

    const configuredSkillSources = await readableSkillSources({
      skillBindings,
      repository: this.repositories.skills,
    });
    const configuredToolEntries = capabilityToolIds.map((toolId) => {
      const tool = toolMap.get(toolId);
      if (!tool) {
        throw new ApplicationError('NOT_FOUND', `Tool not found: ${toolId}`);
      }
      return { reference: displayToolReference({ toolId, tool }), tool };
    });
    const configuredTools = configuredToolEntries.flatMap((entry) =>
      canonicalToolReferenceForView(entry.reference, {
        semanticCapabilityDefinitions,
      }),
    );
    const sources = buildAgentSources({
      configuredSkillSources,
      mcpBindings,
      toolSources,
    });
    const capabilities = buildSelectedCapabilities(
      configuredToolEntries,
      semanticCapabilityDefinitions,
    );
    const toolAccess = buildConfiguredAgentToolAccess(
      configuredTools,
      buildRequestableAdminToolAccess(selectedAdminToolNames(configuredTools)),
    );
    return {
      agentId: input.agentId,
      sources,
      capabilities,
      toolAccess,
      summary: summarizeAgentAccess({
        sources,
        capabilities,
        toolAccess,
        toolBindings: nextToolBindings,
      }),
      updatedAt: now,
    };
  }

  async getSources(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentSourcesView> {
    // Sources derive only from tool/skill/mcp bindings — they do not need the
    // per-tool catalog lookups, capability resolution, tool-access view, or
    // summary that getCapabilities computes, so load only what sources require.
    await this.requireAgent(input.appId, input.agentId);
    const [toolSources, skillBindings, mcpBindings] = await Promise.all([
      this.listAgentToolSources(input),
      this.repositories.skills.listAgentSkillBindings(input),
      this.repositories.mcpServers.listAgentBindings({ ...input, limit: 500 }),
    ]);
    const configuredSkillSources = await readableSkillSources({
      skillBindings,
      repository: this.repositories.skills,
    });
    return {
      agentId: input.agentId,
      sources: buildAgentSources({
        configuredSkillSources,
        mcpBindings,
        toolSources,
      }),
      updatedAt: this.clock.now(),
    };
  }

  async replaceAccessDocument(input: {
    appId: AppId;
    agentId: AgentId;
    sources: AgentCapabilitiesView['sources'];
    capabilities: Array<{ id: string; version: string }>;
  }): Promise<AgentCapabilitiesView> {
    return replaceAgentAccessDocument({
      ...input,
      repositories: this.repositories,
      now: this.clock.now(),
      requireAgent: (appId, agentId) => this.requireAgent(appId, agentId),
      requireInstalledSkills: (appId, skillIds) =>
        this.requireInstalledSkills(appId, skillIds),
      requireActiveMcpServers: (appId, serverIds) =>
        this.requireActiveMcpServers(appId, serverIds),
      requireSelectableTools: (appId, toolIds) =>
        this.requireSelectableTools(appId, toolIds),
      getCapabilities: (scope) => this.getCapabilities(scope),
    });
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
    const skillMap = await this.requireInstalledSkills(
      input.appId,
      sourceSkillIds,
    );
    const mcpServerMap = await this.requireActiveMcpServers(
      input.appId,
      sourceMcpServerIds,
    );
    assertUniqueSkillMaterializationKeys(sourceSkillIds, skillMap);
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
    const nextMcpBindings: AgentMcpServerBinding[] = nextMcpSourceBindings({
      appId: input.appId,
      agentId: input.agentId,
      sources: input.sources.mcpServers,
      servers: mcpServerMap,
      existingBindings: mcpBindings,
      now,
    });
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

  private async requireInstalledSkills(
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
            `Skill is not installed: ${skillId}`,
          );
        }
        skills.set(skillId, skill);
      }),
    );
    return skills;
  }

  private async requireActiveMcpServers(
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
        if (!isMcpServerActive(server)) {
          throw new ApplicationError(
            'INVALID_REQUEST',
            `MCP server is not active: ${serverId}`,
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

function assertUniqueSkillMaterializationKeys(
  skillIds: readonly SkillId[],
  skills: ReadonlyMap<SkillId, SkillCatalogItem>,
): void {
  const [collision] = skillMaterializationCollisions(
    skillIds.flatMap((skillId) => {
      const skill = skills.get(skillId);
      return skill ? [skill] : [];
    }),
  );
  if (!collision) return;
  throw new ApplicationError(
    'CONFLICT',
    formatSkillMaterializationCollision(collision),
  );
}

function capabilitySelectionToToolReference(capabilityId: string): string {
  const id = capabilityId.trim();
  if (id === 'browser.use') return 'Browser';
  if (id.startsWith('RunCommand(')) return id;
  if (isAdminMcpToolFullName(id) || isGantryFacadeExactToolRule(id)) return id;
  return `capability:${id}`;
}

/**
 * Validate selections structurally and resolve them to canonical tool
 * references. Throws ApplicationError('INVALID_REQUEST') on any malformed
 * selection. Source-independent — safe to call before persisting sources.
 */
function resolveSelectedToolReferences(
  capabilities: ReadonlyArray<{ id: string; version: string }>,
  semanticCapabilityDefinitions: Awaited<
    ReturnType<typeof skillActionDefinitionsForAgent>
  >,
): string[] {
  return unique(
    capabilities.flatMap((capability) => {
      const reference = capabilitySelectionToToolReference(capability.id);
      const validation = validateDurableAccessRule(reference, {
        semanticCapabilityDefinitions,
      });
      if (!validation.ok) {
        throw new ApplicationError('INVALID_REQUEST', validation.reason);
      }
      const canonical = canonicalToolReferenceForView(reference, {
        semanticCapabilityDefinitions,
      });
      if (canonical.length === 0) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `Capability selection ${capability.id} is not a durable access rule.`,
        );
      }
      return canonical;
    }),
  );
}

function selectedAdminToolNames(tools: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = adminMcpToolNameFromFullName(tool);
    if (name) names.add(name);
  }
  return names;
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
