import { ApplicationError } from '../common/application-error.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  McpServerDefinition,
  McpServerId,
} from '../../domain/mcp/mcp-servers.js';
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
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import { isGantryFacadeExactToolRule } from '../../shared/agent-tool-references.js';
import { validateDurableAccessRule } from '../../shared/durable-access-policy.js';
import { isAdminMcpToolFullName } from '../../shared/admin-mcp-tools.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import { nextMcpSourceBindings } from './agent-mcp-source-bindings.js';
import {
  canonicalToolReferenceForView,
  skillActionDefinitionsForBindings,
} from './agent-capability-skill-actions.js';
import type { AgentCapabilitiesView } from './agent-capability-administration-service.js';

export async function replaceAgentAccessDocument(input: {
  appId: AppId;
  agentId: AgentId;
  sources: AgentCapabilitiesView['sources'];
  capabilities: Array<{ id: string; version: string }>;
  repositories: {
    agents: AgentRepository;
    tools: ToolCatalogRepository;
    skills: SkillCatalogRepository;
    mcpServers: McpServerRepository;
  };
  now: string;
  requireAgent(appId: AppId, agentId: AgentId): Promise<{ status: string }>;
  requireInstalledSkills(
    appId: AppId,
    skillIds: SkillId[],
  ): Promise<Map<SkillId, SkillCatalogItem>>;
  requireActiveMcpServers(
    appId: AppId,
    serverIds: McpServerId[],
  ): Promise<Map<McpServerId, McpServerDefinition>>;
  requireSelectableTools(
    appId: AppId,
    toolIds: ToolId[],
  ): Promise<Map<ToolId, ToolCatalogItem>>;
  getCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentCapabilitiesView>;
}): Promise<AgentCapabilitiesView> {
  const agent = await input.requireAgent(input.appId, input.agentId);
  if (agent.status !== 'active') {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `Agent is not active: ${input.agentId}`,
    );
  }
  const sourceSkillIds = unique(
    input.sources.skills.map((source) => source.id as SkillId),
  );
  const sourceMcpServerIds = unique(
    input.sources.mcpServers.map((source) => source.id as McpServerId),
  );
  const sourceTools = uniqueToolSources(input.sources.tools, {
    appId: input.appId,
    agentId: input.agentId,
    now: input.now,
  });
  const skillMap = await input.requireInstalledSkills(
    input.appId,
    sourceSkillIds,
  );
  const mcpServerMap = await input.requireActiveMcpServers(
    input.appId,
    sourceMcpServerIds,
  );
  assertUniqueSkillMaterializationKeys(sourceSkillIds, skillMap);

  const [toolBindings, skillBindings, mcpBindings] = await Promise.all([
    input.repositories.tools.listAgentToolBindings(input),
    input.repositories.skills.listAgentSkillBindings(input),
    input.repositories.mcpServers.listAgentBindings({
      appId: input.appId,
      agentId: input.agentId,
      limit: 500,
    }),
  ]);
  const nextSkillBindings = nextSkillSourceBindings({
    appId: input.appId,
    agentId: input.agentId,
    skillIds: sourceSkillIds,
    existingBindings: skillBindings,
    now: input.now,
  });
  const nextMcpBindings = nextMcpSourceBindings({
    appId: input.appId,
    agentId: input.agentId,
    sources: input.sources.mcpServers,
    servers: mcpServerMap,
    existingBindings: mcpBindings,
    now: input.now,
  });
  const semanticCapabilityDefinitions = await skillActionDefinitionsForBindings(
    {
      appId: input.appId,
      skillBindings: nextSkillBindings,
      skillRepository: input.repositories.skills,
    },
  );
  const selectedToolReferences = resolveSelectedToolReferences(
    input.capabilities,
    semanticCapabilityDefinitions,
  );
  const capabilityToolIds = await Promise.all(
    selectedToolReferences.map(async (reference) => {
      const tool = await ensureAgentToolCatalogItem({
        repository: input.repositories.tools,
        appId: input.appId,
        reference,
        now: input.now,
        semanticCapabilityDefinitions,
      });
      return tool.id;
    }),
  );
  await input.requireSelectableTools(input.appId, capabilityToolIds);

  await input.repositories.agents.replaceAgentAccess({
    appId: input.appId,
    agentId: input.agentId,
    toolBindings: nextCapabilityToolBindings({
      appId: input.appId,
      agentId: input.agentId,
      toolIds: capabilityToolIds,
      existingBindings: toolBindings,
      now: input.now,
    }),
    skillBindings: nextSkillBindings,
    mcpBindings: nextMcpBindings,
    toolSources: sourceTools,
    updatedAt: input.now,
  });
  return input.getCapabilities({ appId: input.appId, agentId: input.agentId });
}

function nextCapabilityToolBindings(input: {
  appId: AppId;
  agentId: AgentId;
  toolIds: ToolId[];
  existingBindings: AgentToolBinding[];
  now: string;
}): AgentToolBinding[] {
  const existingByToolId = new Map(
    input.existingBindings.map((binding) => [binding.toolId, binding]),
  );
  const selected = new Set(input.toolIds);
  return [
    ...input.existingBindings
      .filter(
        (binding) =>
          binding.status === 'active' && !selected.has(binding.toolId),
      )
      .map((binding) => ({
        ...binding,
        status: 'disabled' as const,
        updatedAt: input.now,
      })),
    ...input.toolIds.map((toolId) => {
      const existing = existingByToolId.get(toolId);
      return {
        id: `agent-tool-binding:${input.agentId}:${toolId}` as AgentToolBinding['id'],
        appId: input.appId,
        agentId: input.agentId,
        toolId,
        configVersionId: existing?.configVersionId,
        status: 'active' as const,
        createdAt: existing?.createdAt ?? input.now,
        updatedAt: input.now,
      };
    }),
  ];
}

function nextSkillSourceBindings(input: {
  appId: AppId;
  agentId: AgentId;
  skillIds: SkillId[];
  existingBindings: AgentSkillBinding[];
  now: string;
}): AgentSkillBinding[] {
  const existingBySkillId = new Map(
    input.existingBindings.map((binding) => [binding.skillId, binding]),
  );
  return input.skillIds.map((skillId) => {
    const existing = existingBySkillId.get(skillId);
    return {
      id: `agent-skill-binding:${input.agentId}:${skillId}` as AgentSkillBinding['id'],
      appId: input.appId,
      agentId: input.agentId,
      skillId,
      configVersionId: existing?.configVersionId,
      status: 'active' as const,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
  });
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

function resolveSelectedToolReferences(
  capabilities: ReadonlyArray<{ id: string; version: string }>,
  semanticCapabilityDefinitions: Record<string, SemanticCapabilityDefinition>,
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
