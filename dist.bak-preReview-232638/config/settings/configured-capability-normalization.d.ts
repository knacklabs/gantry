import type { AppId } from '../../domain/app/app.js';
import type { SkillCatalogItem } from '../../domain/skills/skills.js';
import type { ToolCatalogItem } from '../../domain/tools/tools.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service-types.js';
import type { RuntimeConfiguredAgentCapability, RuntimeSettings } from './runtime-settings-types.js';
import { type SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
export interface ConfiguredCapabilityNormalizationResult {
    capabilities: RuntimeConfiguredAgentCapability[];
}
export declare function settingsCapabilityIdToToolRule(capabilityId: string): string;
export declare function toolRuleToSettingsCapability(rule: string, version?: string): RuntimeConfiguredAgentCapability;
export declare function skillActionDefinitionsForSkills(skills: readonly SkillCatalogItem[]): SemanticCapabilityDefinition[];
export declare function semanticCapabilityDefinitionsById(definitions: readonly SemanticCapabilityDefinition[]): Record<string, SemanticCapabilityDefinition>;
export declare function semanticCapabilityDefinitionsFromCatalogTools(tools: readonly ToolCatalogItem[]): Record<string, SemanticCapabilityDefinition>;
export declare function normalizeConfiguredCapabilities(input: {
    capabilities: readonly RuntimeConfiguredAgentCapability[];
}): ConfiguredCapabilityNormalizationResult;
export declare function normalizeConfiguredCapabilitiesInSettings(input: {
    settings: RuntimeSettings;
    repositories: SettingsDesiredStateRepositories;
    appId: AppId;
}): Promise<{
    settings: RuntimeSettings;
    changed: boolean;
    changedAgentFolders: string[];
}>;
