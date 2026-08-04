import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service.js';
import type { RuntimeConfiguredAgent, RuntimeSettings } from './runtime-settings-types.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
export declare function replaceDesiredStateCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
    agent: RuntimeConfiguredAgent;
    repositories: SettingsDesiredStateRepositories;
    now: string;
    authoritative: boolean;
}): Promise<void>;
export declare function inlineAgentRuntimeCapabilityErrors(input: {
    appId: AppId;
    settings: RuntimeSettings;
    repositories: SettingsDesiredStateRepositories;
    servers: Map<string, Awaited<ReturnType<SettingsDesiredStateRepositories['mcpServers']['getServer']>>>;
    catalogSemanticCapabilityDefinitions: Record<string, SemanticCapabilityDefinition>;
}): Promise<string[]>;
export declare function settingsCapabilityToToolReference(capability: {
    id: string;
    version: string;
}): string;
