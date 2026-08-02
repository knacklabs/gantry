import { type FamilyOrderOverrides } from '../../shared/model-families.js';
import { type AgentHarness } from '../../shared/agent-engine.js';
import type { RuntimeConfiguredAgent, RuntimeDesiredStateSettings } from './runtime-settings-types.js';
export declare function parseConfiguredAgents(raw: unknown, defaults?: {
    model?: string;
    oneTimeJobDefaultModel?: string;
    recurringJobDefaultModel?: string;
    agentHarness?: AgentHarness;
    modelFamilyOrder?: FamilyOrderOverrides;
}): Record<string, RuntimeConfiguredAgent>;
export declare function parseDesiredStateSettings(raw: unknown): RuntimeDesiredStateSettings;
