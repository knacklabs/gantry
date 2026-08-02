import { formatInlineAgentWorkerOnlyConfigError, inlineWorkerOnlyToolRuleLabels, type AgentRuntime } from '../../shared/agent-runtime.js';
import { type AgentHarness } from '../../shared/agent-engine.js';
import { type FamilyOrderOverrides } from '../../shared/model-families.js';
import type { AgentEffort, RuntimeAgentThinking, RuntimeConfiguredAgent } from './runtime-settings-types.js';
export { formatInlineAgentWorkerOnlyConfigError, inlineWorkerOnlyToolRuleLabels, };
export declare function parseAgentRuntimeValue(raw: unknown, pathPrefix: string): AgentRuntime;
export declare function parseAgentMaxTurnsValue(raw: unknown, pathPrefix: string): number | undefined;
export declare function parseAgentPositiveIntegerValue(raw: unknown, pathPrefix: string): number | undefined;
export declare function parseAgentEffortValue(raw: unknown, pathPrefix: string): AgentEffort | undefined;
export declare function parseAgentThinkingValue(raw: unknown, pathPrefix: string): RuntimeAgentThinking | undefined;
export declare function configuredAgentControlConstraintErrors(input: {
    subject: string;
    agent: RuntimeConfiguredAgent;
    defaultModel?: string;
    defaultOneTimeJobDefaultModel?: string;
    defaultRecurringJobDefaultModel?: string;
    defaultAgentHarness?: AgentHarness;
    modelFamilyOrder?: FamilyOrderOverrides;
}): string[];
export declare function resolveConfiguredAgentRuntime(agent: Pick<RuntimeConfiguredAgent, 'runtime'> | undefined): AgentRuntime;
export declare function inlineWorkerOnlyConfiguredCapabilityLabels(input: {
    agent: RuntimeConfiguredAgent;
    stdioMcpServerIds?: ReadonlySet<string>;
}): string[];
export declare function inlineConfiguredSkillEngineConstraintError(input: {
    subject: string;
    agent: RuntimeConfiguredAgent;
    defaultModel?: string;
    defaultOneTimeJobDefaultModel?: string;
    defaultRecurringJobDefaultModel?: string;
    modelFamilyOrder?: FamilyOrderOverrides;
}): string | null;
