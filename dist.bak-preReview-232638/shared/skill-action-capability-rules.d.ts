import { type SemanticCapabilityDefinition } from './semantic-capabilities.js';
export declare function canonicalizeDurableSkillActionToolRule(rule: string, options?: {
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition> | readonly SemanticCapabilityDefinition[];
    dropGeneratedWithoutMatch?: boolean;
}): string | undefined;
export declare function skillActionCapabilityRuleForToolRule(rule: string, definitions: Record<string, SemanticCapabilityDefinition> | readonly SemanticCapabilityDefinition[] | undefined): string | undefined;
