import type { AgentPersona } from '../../shared/agent-persona.js';
import { applyModelDefaults, applyProviderManagedMemoryDefaults, createDefaultRuntimeSettings, DEFAULT_EMBED_DIMENSIONS, DEFAULT_EMBED_MODEL, getProviderManagedMemoryDefaults } from './runtime-settings-defaults.js';
import { parseRuntimeSettings } from './runtime-settings-parser.js';
import { readRuntimeMemorySettingsSnapshot, readRuntimeObserverSettingsSnapshot, readRuntimeStorageSettingsSnapshot } from './runtime-settings-snapshots.js';
import type { RuntimeSettings, RuntimeSettingsValidationResult } from './runtime-settings-types.js';
export { configureDesiredSettingsStorageProvider, loadDesiredRuntimeSettingsForWrite, noteRestartRequired, writeDesiredRuntimeSettings, } from './desired-settings-writer.js';
export type { EmbeddingProviderName, MemoryModelTask, RuntimeMemoryLlmModels, RuntimeMemorySettings, RuntimeMemorySettingsSnapshot, RuntimeObserverSettings, AgentRuntime, RuntimeSettings, RuntimeSettingsValidationFailure, RuntimeSettingsValidationResult, RuntimeStorageSettings, RuntimeStorageSettingsSnapshot, } from './runtime-settings-types.js';
export { applyModelDefaults, applyProviderManagedMemoryDefaults, createDefaultRuntimeSettings, DEFAULT_EMBED_DIMENSIONS, DEFAULT_EMBED_MODEL, getProviderManagedMemoryDefaults, parseRuntimeSettings, readRuntimeMemorySettingsSnapshot, readRuntimeObserverSettingsSnapshot, readRuntimeStorageSettingsSnapshot, };
export interface EnsureConfiguredConversationBindingInput {
    agentId: string;
    agentName: string;
    agentFolder: string;
    jid: string;
    displayName: string;
    trigger: string;
    requiresTrigger: boolean;
    persona?: AgentPersona;
    approverIds?: string[];
}
export declare function ensureConfiguredAgent(settings: RuntimeSettings, input: {
    agentId: string;
    agentName: string;
    agentFolder?: string;
    persona?: AgentPersona;
}): void;
export declare function saveRuntimeSettings(runtimeHome: string, settings: RuntimeSettings): void;
export declare function mirrorAgentToolRulesToRuntimeSettings(input: {
    runtimeHome: string;
    agentFolder: string;
    rules: readonly string[];
    mode?: 'add' | 'remove';
}): void;
export declare function addAgentToolRulesToRuntimeSettings(settings: RuntimeSettings, agentFolder: string, rules: readonly string[]): void;
export declare function removeAgentToolRulesFromRuntimeSettings(settings: RuntimeSettings, agentFolder: string, rules: readonly string[]): void;
export declare function capabilityToToolRule(capabilityId: string): string;
export declare function readRuntimeSettingsYaml(runtimeHome: string): string;
export declare function getRuntimeSettingsRevision(runtimeHome: string): string;
export declare function addControlSenderForAgent(settings: RuntimeSettings, providerId: string, folder: string, sender: string): boolean;
export declare function ensureConfiguredConversationBinding(settings: RuntimeSettings, input: EnsureConfiguredConversationBindingInput): {
    providerId: string;
    providerConnectionId: string;
    conversationId: string;
    bindingId: string;
};
export declare function loadRuntimeSettingsFromPath(filePath: string): RuntimeSettings;
export declare function activateRuntimeModelAliases(settings: RuntimeSettings): void;
export declare function withRuntimeModelAliases<T>(settings: RuntimeSettings, fn: () => T): T;
export declare function ensureRuntimeSettings(runtimeHome: string): RuntimeSettings;
export declare function loadRuntimeSettings(runtimeHome: string): RuntimeSettings;
export declare function validateRuntimeSettings(runtimeHome: string): RuntimeSettingsValidationResult;
