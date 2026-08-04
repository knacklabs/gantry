import { parseReadableScopedToolRule, RUN_COMMAND_TOOL_NAME, } from './agent-tool-references.js';
import { canonicalizeGeneratedRuntimeSkillPaths, containsGeneratedRuntimeSkillPath, } from './generated-runtime-paths.js';
import { semanticCapabilityRuntimeRules, validateSemanticCapabilityDefinition, } from './semantic-capabilities.js';
import { semanticCapabilityRule } from './semantic-capability-ids.js';
import { toolRuleCoversRule } from './tool-rule-matcher.js';
export function canonicalizeDurableSkillActionToolRule(rule, options = {}) {
    const trimmed = rule.trim();
    if (!trimmed)
        return undefined;
    const hadGeneratedPath = containsGeneratedRuntimeSkillPath(trimmed);
    const canonicalRule = canonicalizeGeneratedRuntimeSkillPaths(trimmed).trim();
    const skillActionRule = skillActionCapabilityRuleForToolRule(canonicalRule, options.semanticCapabilityDefinitions);
    if (skillActionRule)
        return skillActionRule;
    if (hadGeneratedPath && options.dropGeneratedWithoutMatch !== false) {
        return undefined;
    }
    return canonicalRule;
}
export function skillActionCapabilityRuleForToolRule(rule, definitions) {
    const canonicalRule = canonicalizeGeneratedRuntimeSkillPaths(rule).trim();
    const scoped = parseReadableScopedToolRule(canonicalRule);
    if (scoped?.toolName !== RUN_COMMAND_TOOL_NAME)
        return undefined;
    for (const definition of trustedSkillActionDefinitions(definitions)) {
        if (skillActionDefinitionCoversRule(definition, canonicalRule)) {
            return semanticCapabilityRule(definition.capabilityId);
        }
    }
    return undefined;
}
function trustedSkillActionDefinitions(definitions) {
    const values = Array.isArray(definitions)
        ? definitions
        : Object.values(definitions ?? {});
    return values.filter((definition) => {
        if (!definition.capabilityId?.startsWith('skill.'))
            return false;
        if (definition.credentialSource === 'local_cli')
            return false;
        return validateSemanticCapabilityDefinition(definition).ok;
    });
}
function skillActionDefinitionCoversRule(definition, candidateRule) {
    return semanticCapabilityRuntimeRules(definition).some((runtimeRule) => {
        const stableRuntimeRule = canonicalizeGeneratedRuntimeSkillPaths(runtimeRule).trim();
        return (stableRuntimeRule === candidateRule ||
            toolRuleCoversRule(stableRuntimeRule, candidateRule));
    });
}
