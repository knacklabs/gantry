import type { AppId } from '../../domain/app/app.js';
import { resolveAgentToolReference } from '../../domain/tools/agent-tool-catalog-references.js';
import {
  formatSkillMaterializationCollisionFragment,
  skillMaterializationCollisions,
} from '../../domain/skills/skill-identity.js';
import {
  inlineAgentRuntimeCapabilityErrors,
  settingsCapabilityToToolReference,
} from './desired-state-capability-reconcile.js';
import {
  normalizeConfiguredCapabilities,
  semanticCapabilityDefinitionsById,
  semanticCapabilityDefinitionsFromCatalogTools,
  skillActionDefinitionsForSkills,
} from './configured-capability-normalization.js';
import {
  agentIdForFolder,
  loadMcpServersById,
} from './desired-state-service-helpers.js';
import {
  resolveConfiguredSkillReferences,
  selectedSkillsFromResolvedSkillReferences,
} from './desired-state-skill-references.js';
import type { SettingsDesiredStateServiceDeps } from './desired-state-service-types.js';
import type { RuntimeSettings } from './runtime-settings-types.js';

export async function validateDesiredStateCapabilityReferences(input: {
  appId: AppId;
  deps: SettingsDesiredStateServiceDeps;
  settings: RuntimeSettings;
}): Promise<string[]> {
  const { appId, deps, settings } = input;
  const errors: string[] = [];
  const serverIds = new Set<string>();
  for (const agent of Object.values(settings.agents)) {
    for (const source of agent.sources.mcpServers) {
      if (source.status === 'disabled') continue;
      serverIds.add(source.id);
    }
  }
  const servers = await loadMcpServersById(deps.repositories.mcpServers, [
    ...serverIds,
  ]);
  const catalogSemanticCapabilityDefinitions =
    semanticCapabilityDefinitionsFromCatalogTools(
      await deps.repositories.tools.listTools({
        appId,
        statuses: ['active'],
      }),
    );
  errors.push(
    ...(await inlineAgentRuntimeCapabilityErrors({
      appId,
      settings,
      repositories: deps.repositories,
      servers,
      catalogSemanticCapabilityDefinitions,
    })),
  );
  for (const [folder, agent] of Object.entries(settings.agents)) {
    const activeSkillSources = agent.sources.skills.filter(
      (source) => source.status !== 'disabled',
    );
    const resolvedSkills = await resolveConfiguredSkillReferences({
      repository: deps.repositories.skills,
      appId,
      agentId: agentIdForFolder(folder),
      references: activeSkillSources.map((source) => source.id),
    });
    const [skillCollision] = skillMaterializationCollisions(
      selectedSkillsFromResolvedSkillReferences(
        activeSkillSources.map((source) => source.id),
        resolvedSkills,
      ),
    );
    if (skillCollision) {
      errors.push(
        `agents.${folder}.sources.skills contains ${formatSkillMaterializationCollisionFragment(skillCollision)}`,
      );
    }
    const skillActionDefinitionsForAgent = skillActionDefinitionsForSkills([
      ...resolvedSkills.skills.values(),
    ]);
    const skillActionDefinitions = {
      ...catalogSemanticCapabilityDefinitions,
      ...semanticCapabilityDefinitionsById(skillActionDefinitionsForAgent),
    };
    const normalizedCapabilities = normalizeConfiguredCapabilities({
      capabilities: agent.capabilities,
    }).capabilities;
    for (const capability of [
      ...new Set(normalizedCapabilities.map((item) => item.id)),
    ]) {
      const toolReference = settingsCapabilityToToolReference({
        id: capability,
        version: 'builtin',
      });
      const resolved = await resolveAgentToolReference({
        repository: deps.repositories.tools,
        appId,
        reference: toolReference,
        semanticCapabilityDefinitions: skillActionDefinitions,
      });
      if (resolved.error) {
        errors.push(
          `agents.${folder}.capabilities contains unavailable capability ${capability}: ${resolved.error}`,
        );
      }
    }
    for (const skillId of [
      ...new Set(activeSkillSources.map((source) => source.id)),
    ]) {
      const skill = resolvedSkills.skills.get(skillId);
      const resolutionError = resolvedSkills.errors.get(skillId);
      if (!skill || resolutionError) {
        errors.push(
          `agents.${folder}.sources.skills contains ${resolutionError ?? `unavailable skill: ${skillId}`}`,
        );
      } else if (!skill.storage) {
        errors.push(
          `agents.${folder}.sources.skills references skill without artifact storage: ${skillId}`,
        );
      }
    }
    for (const serverId of [
      ...new Set(
        agent.sources.mcpServers
          .filter((source) => source.status !== 'disabled')
          .map((source) => source.id),
      ),
    ]) {
      const server = servers.get(serverId);
      if (!server || server.appId !== appId || server.status !== 'active') {
        errors.push(
          `agents.${folder}.sources.mcp_servers contains unavailable MCP server: ${serverId}`,
        );
      }
    }
  }
  return errors.sort();
}
