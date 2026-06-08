import type { AppId } from '../../domain/app/app.js';
import type { SkillCatalogItem } from '../../domain/skills/skills.js';
import { skillActionSemanticCapability } from '../../domain/skills/skill-action-permissions.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service-types.js';
import type {
  RuntimeConfiguredAgentCapability,
  RuntimeSettings,
} from './runtime-settings-types.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';

export interface ConfiguredCapabilityNormalizationResult {
  capabilities: RuntimeConfiguredAgentCapability[];
}

export function settingsCapabilityIdToToolRule(capabilityId: string): string {
  const id = capabilityId.trim();
  if (id === 'browser.use') return 'Browser';
  if (id.includes('.') && !id.startsWith('RunCommand(')) {
    return `capability:${id}`;
  }
  return id;
}

export function toolRuleToSettingsCapability(
  rule: string,
  version = 'builtin',
): RuntimeConfiguredAgentCapability {
  if (rule === 'Browser') return { id: 'browser.use', version };
  if (rule.startsWith('capability:')) {
    return { id: rule.slice('capability:'.length), version };
  }
  return { id: rule, version };
}

export function skillActionDefinitionsForSkills(
  skills: readonly SkillCatalogItem[],
): SemanticCapabilityDefinition[] {
  return skills.flatMap((skill) =>
    (skill.actionPermissions ?? []).map((action) =>
      skillActionSemanticCapability({
        skillId: String(skill.id),
        skillName: skill.name,
        action,
      }),
    ),
  );
}

export function semanticCapabilityDefinitionsById(
  definitions: readonly SemanticCapabilityDefinition[],
): Record<string, SemanticCapabilityDefinition> {
  return Object.fromEntries(
    definitions.map((definition) => [definition.capabilityId, definition]),
  );
}

export function normalizeConfiguredCapabilities(input: {
  capabilities: readonly RuntimeConfiguredAgentCapability[];
}): ConfiguredCapabilityNormalizationResult {
  const capabilities: RuntimeConfiguredAgentCapability[] = [];
  const seen = new Set<string>();

  for (const capability of input.capabilities) {
    const key = `${capability.id}\0${capability.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    capabilities.push(capability);
  }

  return { capabilities };
}

export async function normalizeConfiguredCapabilitiesInSettings(input: {
  settings: RuntimeSettings;
  repositories: SettingsDesiredStateRepositories;
  appId: AppId;
}): Promise<{
  settings: RuntimeSettings;
  changed: boolean;
  changedAgentFolders: string[];
}> {
  let nextSettings: RuntimeSettings | undefined;
  const changedAgentFolders: string[] = [];

  for (const [folder, agent] of Object.entries(input.settings.agents)) {
    const normalized = normalizeConfiguredCapabilities({
      capabilities: agent.capabilities,
    });
    if (sameCapabilities(agent.capabilities, normalized.capabilities)) {
      continue;
    }
    nextSettings ??= structuredClone(input.settings);
    nextSettings.agents[folder].capabilities = normalized.capabilities;
    changedAgentFolders.push(folder);
  }

  return {
    settings: nextSettings ?? input.settings,
    changed: Boolean(nextSettings),
    changedAgentFolders,
  };
}

function sameCapabilities(
  left: readonly RuntimeConfiguredAgentCapability[],
  right: readonly RuntimeConfiguredAgentCapability[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (capability, index) =>
      capability.id === right[index]?.id &&
      capability.version === right[index]?.version,
  );
}
