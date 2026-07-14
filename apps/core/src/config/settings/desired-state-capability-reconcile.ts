import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerId } from '../../domain/mcp/mcp-servers.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeSettings,
} from './runtime-settings-types.js';
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import { resolveAgentToolReference } from '../../domain/tools/agent-tool-catalog-references.js';
import type { AgentToolSource } from '../../domain/tools/tools.js';
import {
  resolveConfiguredSkillReferences,
  selectedSkillsFromResolvedSkillReferences,
} from './desired-state-skill-references.js';
import { validateDurableAccessRule } from '../../shared/durable-access-policy.js';
import { isValidSemanticCapabilityId } from '../../shared/semantic-capability-ids.js';
import {
  formatSkillMaterializationCollision,
  skillMaterializationCollisions,
} from '../../domain/skills/skill-identity.js';
import {
  normalizeConfiguredCapabilities,
  semanticCapabilityDefinitionsById,
  semanticCapabilityDefinitionsFromCatalogTools,
  settingsCapabilityIdToToolRule,
  skillActionDefinitionsForSkills,
} from './configured-capability-normalization.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import { projectToolCatalogItemToRuntimeRules } from '../../shared/semantic-capabilities.js';
import {
  normalizeMcpToolScope,
  reviewedMcpToolPatterns,
} from '../../shared/mcp-tool-scope.js';
import {
  formatInlineAgentWorkerOnlyConfigError,
  inlineConfiguredSkillEngineConstraintError,
  inlineWorkerOnlyConfiguredCapabilityLabels,
  inlineWorkerOnlyToolRuleLabels,
  resolveConfiguredAgentRuntime,
} from './runtime-settings-agent-runtime.js';

export async function replaceDesiredStateCapabilities(input: {
  appId: AppId;
  agentId: AgentId;
  agent: RuntimeConfiguredAgent;
  repositories: SettingsDesiredStateRepositories;
  now: string;
}): Promise<void> {
  const resolvedSkills = await resolveConfiguredSkillReferences({
    repository: input.repositories.skills,
    appId: input.appId,
    agentId: input.agentId,
    references: input.agent.sources.skills.map((source) => source.id),
  });
  if (resolvedSkills.errors.size > 0) {
    throw new Error([...resolvedSkills.errors.values()][0]);
  }
  const skillIds = [
    ...new Set(
      input.agent.sources.skills
        .map((source) => source.id)
        .map((reference) => String(resolvedSkills.skills.get(reference)!.id)),
    ),
  ];
  const [skillCollision] = skillMaterializationCollisions(
    selectedSkillsFromResolvedSkillReferences(
      input.agent.sources.skills.map((source) => source.id),
      resolvedSkills,
    ),
  );
  if (skillCollision) {
    throw new Error(formatSkillMaterializationCollision(skillCollision));
  }
  const skillActionDefinitions = skillActionDefinitionsForSkills([
    ...resolvedSkills.skills.values(),
  ]);
  const mcpBindings = await configuredMcpSourceBindings(input);
  const toolIds = await toolIdsForReplacement({
    ...input,
    skillActionDefinitions,
  });
  await input.repositories.agents.replaceAgentCapabilityBindings({
    appId: input.appId,
    agentId: input.agentId,
    toolBindings: toolIds.map((toolId) => ({
      id: `agent-tool-binding:${input.agentId}:${toolId}` as never,
      appId: input.appId,
      agentId: input.agentId,
      toolId: toolId as never,
      status: 'active' as const,
      createdAt: input.now,
      updatedAt: input.now,
    })),
    skillBindings: skillIds.map((skillId) => ({
      id: `agent-skill-binding:${input.agentId}:${skillId}` as never,
      appId: input.appId,
      agentId: input.agentId,
      skillId: skillId as never,
      status: 'active' as const,
      createdAt: input.now,
      updatedAt: input.now,
    })),
    mcpBindings,
    updatedAt: input.now,
  });
  await replaceAgentToolSources(input);
}

export async function inlineAgentRuntimeCapabilityErrors(input: {
  appId: AppId;
  settings: RuntimeSettings;
  repositories: SettingsDesiredStateRepositories;
  servers: Map<
    string,
    Awaited<
      ReturnType<SettingsDesiredStateRepositories['mcpServers']['getServer']>
    >
  >;
  catalogSemanticCapabilityDefinitions: Record<
    string,
    SemanticCapabilityDefinition
  >;
}): Promise<string[]> {
  const errors: string[] = [];
  for (const [folder, agent] of Object.entries(input.settings.agents)) {
    if (resolveConfiguredAgentRuntime(agent) !== 'inline') continue;
    const skillEngineError = inlineConfiguredSkillEngineConstraintError({
      subject: `agents.${folder}`,
      agent,
      defaultModel: input.settings.agent.defaultModel,
      defaultOneTimeJobDefaultModel:
        input.settings.agent.oneTimeJobDefaultModel,
      defaultRecurringJobDefaultModel:
        input.settings.agent.recurringJobDefaultModel,
      modelFamilyOrder: input.settings.modelFamilies,
    });
    if (skillEngineError) errors.push(skillEngineError);
    const blockers = new Set(
      inlineWorkerOnlyConfiguredCapabilityLabels({
        agent,
        stdioMcpServerIds: new Set(
          agent.sources.mcpServers
            .filter(
              (source) =>
                input.servers.get(source.id)?.transport === 'stdio_template',
            )
            .map((source) => source.id),
        ),
      }),
    );
    const resolvedSkills = await resolveConfiguredSkillReferences({
      repository: input.repositories.skills,
      appId: input.appId,
      agentId: `agent:${folder}` as AgentId,
      references: agent.sources.skills.map((source) => source.id),
    });
    const skillActionDefinitions = {
      ...input.catalogSemanticCapabilityDefinitions,
      ...semanticCapabilityDefinitionsById(
        skillActionDefinitionsForSkills([...resolvedSkills.skills.values()]),
      ),
    };
    const normalizedCapabilities = normalizeConfiguredCapabilities({
      capabilities: agent.capabilities,
    }).capabilities;
    for (const capability of [
      ...new Set(normalizedCapabilities.map((item) => item.id)),
    ]) {
      const resolved = await resolveAgentToolReference({
        repository: input.repositories.tools,
        appId: input.appId,
        reference: settingsCapabilityToToolReference({
          id: capability,
          version: 'builtin',
        }),
        semanticCapabilityDefinitions: skillActionDefinitions,
      });
      if (!resolved.tool?.name) continue;
      if (
        inlineWorkerOnlyToolRuleLabels(
          projectToolCatalogItemToRuntimeRules({
            name: resolved.tool.name,
            inputSchema: resolved.tool.inputSchema,
          }),
        ).length > 0
      ) {
        blockers.add(capability);
      }
    }
    if (blockers.size > 0) {
      errors.push(
        formatInlineAgentWorkerOnlyConfigError(
          `agents.${folder}`,
          [...blockers].sort(),
        ),
      );
    }
  }
  return errors.sort();
}

async function replaceAgentToolSources(input: {
  appId: AppId;
  agentId: AgentId;
  agent: RuntimeConfiguredAgent;
  repositories: SettingsDesiredStateRepositories;
  now: string;
}): Promise<void> {
  if (!input.repositories.tools.replaceAgentToolSources) {
    if (input.agent.sources.tools.length === 0) return;
    throw new Error('Tool source attachments repository is unavailable.');
  }
  await input.repositories.tools.replaceAgentToolSources({
    appId: input.appId,
    agentId: input.agentId,
    sources: input.agent.sources.tools.map((source) =>
      configuredToolSourceToAttachment({
        appId: input.appId,
        agentId: input.agentId,
        source,
        now: input.now,
      }),
    ),
    updatedAt: input.now,
  });
}

function configuredToolSourceToAttachment(input: {
  appId: AppId;
  agentId: AgentId;
  source: RuntimeConfiguredAgent['sources']['tools'][number];
  now: string;
}): AgentToolSource {
  const kind = configuredToolSourceKind(input.source.kind);
  const version = input.source.version ?? kind;
  return {
    id: `agent-tool-source:${input.agentId}:${kind}:${input.source.id}:${version}` as AgentToolSource['id'],
    appId: input.appId,
    agentId: input.agentId,
    sourceId: input.source.id,
    kind,
    version,
    status: 'active',
    createdAt: input.now as never,
    updatedAt: input.now as never,
  };
}

function configuredToolSourceKind(
  kind: RuntimeConfiguredAgent['sources']['tools'][number]['kind'],
): AgentToolSource['kind'] {
  if (kind === undefined || kind === 'builtin') return 'builtin';
  if (kind === 'adapter' || kind === 'local_cli') return kind;
  throw new Error(`Unsupported tool source kind: ${kind}`);
}

async function toolIdsForReplacement(input: {
  appId: AppId;
  agent: RuntimeConfiguredAgent;
  repositories: SettingsDesiredStateRepositories;
  now: string;
  skillActionDefinitions?: readonly SemanticCapabilityDefinition[];
}): Promise<string[]> {
  const normalized = normalizeConfiguredCapabilities({
    capabilities: input.agent.capabilities,
  });
  const semanticCapabilityDefinitions = {
    ...(await catalogSemanticCapabilityDefinitions(input)),
    ...semanticCapabilityDefinitionsById(input.skillActionDefinitions ?? []),
  };
  const ids = await Promise.all(
    [
      ...new Set(
        normalized.capabilities.map(settingsCapabilityToToolReference),
      ),
    ].map(async (reference) => {
      const tool = await ensureAgentToolCatalogItem({
        repository: input.repositories.tools,
        appId: input.appId,
        reference,
        now: input.now,
        semanticCapabilityDefinitions,
      });
      return String(tool.id);
    }),
  );
  return ids;
}

async function catalogSemanticCapabilityDefinitions(input: {
  appId: AppId;
  repositories: SettingsDesiredStateRepositories;
}): Promise<Record<string, SemanticCapabilityDefinition>> {
  const tools = await input.repositories.tools.listTools({
    appId: input.appId,
    statuses: ['active'],
  });
  return semanticCapabilityDefinitionsFromCatalogTools(tools);
}

async function configuredMcpSourceBindings(input: {
  appId: AppId;
  agentId: AgentId;
  agent: RuntimeConfiguredAgent;
  repositories: SettingsDesiredStateRepositories;
  now: string;
}) {
  return Promise.all(
    input.agent.sources.mcpServers.map(async (source) => {
      const serverId = source.id as McpServerId;
      const server = await input.repositories.mcpServers.getServer(serverId);
      if (
        !server ||
        server.appId !== input.appId ||
        server.status !== 'active'
      ) {
        throw new Error(
          `MCP server ${source.id} is not active for that source.`,
        );
      }
      return {
        id: `agent-mcp-binding:${input.agentId}:${serverId}` as never,
        appId: input.appId,
        agentId: input.agentId,
        serverId,
        status: 'active' as const,
        required: false,
        permissionPolicyIds: [],
        allowedToolPatterns: normalizeMcpToolScope({
          serverName: server.name,
          requested: source.tools,
          definitionPatterns: reviewedMcpToolPatterns(server),
        }),
        createdAt: input.now,
        updatedAt: input.now,
      };
    }),
  );
}

export function settingsCapabilityToToolReference(capability: {
  id: string;
  version: string;
}): string {
  if (capability.id === 'browser.use') return 'Browser';
  if (
    !isValidSemanticCapabilityId(capability.id) &&
    validateDurableAccessRule(settingsCapabilityIdToToolRule(capability.id), {
      allowUnknownSemanticCapability: true,
    }).ok
  ) {
    return settingsCapabilityIdToToolRule(capability.id);
  }
  return `capability:${capability.id}`;
}
