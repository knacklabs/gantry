import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service.js';
import type { RuntimeConfiguredAgentCapabilities } from './runtime-settings-types.js';

export async function replaceDesiredStateCapabilities(input: {
  appId: AppId;
  agentId: AgentId;
  capabilities: RuntimeConfiguredAgentCapabilities;
  repositories: SettingsDesiredStateRepositories;
  now: string;
  preserveOpaqueSkillBindings?: boolean;
}): Promise<void> {
  const skillIds = await skillIdsForReplacement(input);
  const mcpServersById = await getApprovedMcpServersById(input);
  await input.repositories.agents.replaceAgentCapabilityBindings({
    appId: input.appId,
    agentId: input.agentId,
    toolBindings: input.capabilities.toolIds.map((toolId) => ({
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
    mcpBindings: input.capabilities.mcpServerIds.map((serverId) => {
      const server = mcpServersById.get(serverId);
      return {
        id: `agent-mcp-binding:${input.agentId}:${serverId}` as never,
        appId: input.appId,
        agentId: input.agentId,
        serverId: serverId as never,
        versionId: server!.latestApprovedVersionId! as never,
        status: 'active' as const,
        required: false,
        permissionPolicyIds: [],
        createdAt: input.now,
        updatedAt: input.now,
      };
    }),
    updatedAt: input.now,
  });
}

async function skillIdsForReplacement(input: {
  appId: AppId;
  agentId: AgentId;
  capabilities: RuntimeConfiguredAgentCapabilities;
  repositories: SettingsDesiredStateRepositories;
  preserveOpaqueSkillBindings?: boolean;
}): Promise<string[]> {
  const next = new Set(input.capabilities.skillIds);
  if (!input.preserveOpaqueSkillBindings) return [...next];
  const existing = await input.repositories.skills.listAgentSkillBindings({
    appId: input.appId,
    agentId: input.agentId,
  });
  for (const binding of existing) {
    const skillId = String(binding.skillId);
    if (binding.status === 'active' && isOpaqueSkillId(skillId)) {
      next.add(skillId);
    }
  }
  return [...next];
}

async function getApprovedMcpServersById(input: {
  capabilities: RuntimeConfiguredAgentCapabilities;
  repositories: SettingsDesiredStateRepositories;
}): Promise<Map<string, { latestApprovedVersionId?: string }>> {
  const servers = await Promise.all(
    [...new Set(input.capabilities.mcpServerIds)].map(
      async (serverId) =>
        [
          serverId,
          await input.repositories.mcpServers.getServer(serverId as never),
        ] as const,
    ),
  );
  return new Map(
    servers
      .filter(([, server]) => server)
      .map(([serverId, server]) => [
        serverId,
        { latestApprovedVersionId: server!.latestApprovedVersionId },
      ]),
  );
}

function isOpaqueSkillId(value: string): boolean {
  return /^skill:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
