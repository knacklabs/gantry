import { type AgentEngine } from './agent-engine.js';
export type AgentRuntime = 'worker' | 'inline';
export declare function inlineWorkerOnlyToolRuleLabels(rules: readonly string[]): string[];
export declare function formatInlineAgentWorkerOnlyConfigError(subject: string, labels: readonly string[]): string;
export declare function inlineAgentSkillEngineConstraintError(input: {
    subject: string;
    agentRuntime?: AgentRuntime;
    agentEngine: AgentEngine;
    attachedSkillSourceIds?: readonly string[];
}): string | null;
export declare function isInlineWorkerOnlyToolRule(rule: string): boolean;
