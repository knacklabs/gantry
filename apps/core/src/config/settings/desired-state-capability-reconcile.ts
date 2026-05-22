import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  McpServerId,
  McpServerVersionId,
} from '../../domain/mcp/mcp-servers.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service.js';
import type { RuntimeConfiguredAgent } from './runtime-settings-types.js';
import { ensureAgentToolCatalogItem } from '../../domain/tools/agent-tool-catalog-references.js';
import type { AgentToolSource } from '../../domain/tools/tools.js';
import { resolveConfiguredSkillReferences } from './desired-state-skill-references.js';
import { validateReadableAgentToolRule } from '../../shared/agent-tool-references.js';
import { isValidSemanticCapabilityId } from '../../shared/semantic-capability-ids.js';

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
  const mcpVersionByServerId = await resolveConfiguredMcpSourceVersions(input);
  const toolIds = await toolIdsForReplacement(input);
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
    mcpBindings: input.agent.sources.mcpServers
      .map((source) => source.id as McpServerId)
      .map((serverId) => {
        return {
          id: `agent-mcp-binding:${input.agentId}:${serverId}` as never,
          appId: input.appId,
          agentId: input.agentId,
          serverId: serverId as never,
          versionId: mcpVersionByServerId.get(serverId)! as never,
          status: 'active' as const,
          required: false,
          permissionPolicyIds: [],
          createdAt: input.now,
          updatedAt: input.now,
        };
      }),
    updatedAt: input.now,
  });
  await replaceAgentToolSources(input);
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
}): Promise<string[]> {
  const ids = await Promise.all(
    [
      ...new Set(
        input.agent.capabilities.map(settingsCapabilityToToolReference),
      ),
    ].map(async (reference) => {
      const tool = await ensureAgentToolCatalogItem({
        repository: input.repositories.tools,
        appId: input.appId,
        reference,
        now: input.now,
      });
      return String(tool.id);
    }),
  );
  return ids;
}

async function resolveConfiguredMcpSourceVersions(input: {
  appId: AppId;
  agent: RuntimeConfiguredAgent;
  repositories: SettingsDesiredStateRepositories;
}): Promise<Map<McpServerId, McpServerVersionId>> {
  const sourceMap = new Map(
    input.agent.sources.mcpServers.map((source) => [
      source.id as McpServerId,
      source.version as McpServerVersionId,
    ]),
  );
  const entries = await Promise.all(
    [...new Set(input.agent.sources.mcpServers.map((source) => source.id))].map(
      async (serverId) => {
        const requestedVersionId = sourceMap.get(serverId as McpServerId)!;
        const [server, version] = await Promise.all([
          input.repositories.mcpServers.getServer(serverId as never),
          input.repositories.mcpServers.getVersion(requestedVersionId),
        ]);
        if (!server?.latestApprovedVersionId) {
          throw new Error(`MCP server ${serverId} has no approved version.`);
        }
        if (
          !version ||
          version.appId !== input.appId ||
          version.serverId !== serverId
        ) {
          throw new Error(
            `MCP server ${serverId} version ${requestedVersionId} is not approved for that source.`,
          );
        }
        return [serverId as McpServerId, requestedVersionId] as const;
      },
    ),
  );
  return new Map(entries);
}

export function settingsCapabilityToToolReference(capability: {
  id: string;
  version: string;
}): string {
  if (capability.id === 'browser.use') return 'Browser';
  if (
    !isValidSemanticCapabilityId(capability.id) &&
    validateReadableAgentToolRule(capability.id).ok
  ) {
    return capability.id;
  }
  return `capability:${capability.id}`;
}
