import { type SemanticCapabilityDefinition } from './semantic-capabilities.js';
export interface ResolvedCapabilityRules {
    rules: string[];
    capabilityByRule: Map<string, string>;
}
export declare function resolveCapabilityRules(rules: readonly string[], definitions: Record<string, SemanticCapabilityDefinition> | undefined): ResolvedCapabilityRules;
