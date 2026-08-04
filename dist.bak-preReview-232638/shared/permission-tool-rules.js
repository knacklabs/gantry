import { normalizePersistentBashRuleContent } from './bash-command-parser.js';
import { publicGantryToolNameForSdkTool, RUN_COMMAND_TOOL_NAME, } from './agent-tool-references.js';
export function permissionUpdateAllowedToolRules(updates) {
    const out = new Set();
    for (const update of updates ?? []) {
        if (!isPermissionUpdateLike(update))
            continue;
        if (update.type !== 'addRules' && update.type !== 'replaceRules') {
            continue;
        }
        if (update.behavior !== 'allow')
            continue;
        const rules = Array.isArray(update.rules) ? update.rules : [];
        for (const rule of rules) {
            const allowedRule = permissionRuleAllowedToolRule(rule);
            if (allowedRule)
                out.add(allowedRule);
        }
    }
    return [...out];
}
export function persistentPermissionUpdates(decision) {
    if (decision.approved !== true ||
        decision.mode !== 'allow_persistent_rule' ||
        decision.decisionClassification !== 'user_permanent') {
        return undefined;
    }
    return decision.updatedPermissions;
}
function permissionRuleAllowedToolRule(rule) {
    if (!isPermissionRuleLike(rule))
        return null;
    const toolName = trimmedString(rule.toolName, 120);
    if (!toolName)
        return null;
    if (toolName.includes('(') || toolName.includes(')'))
        return null;
    const publicToolName = publicGantryToolNameForSdkTool(toolName);
    const ruleContent = trimmedString(rule.ruleContent, 2048);
    if (ruleContent === null)
        return null;
    const normalizedRuleContent = publicToolName === RUN_COMMAND_TOOL_NAME && ruleContent
        ? normalizePersistentBashRuleContent(ruleContent)
        : ruleContent;
    return normalizedRuleContent
        ? `${publicToolName}(${normalizedRuleContent})`
        : publicToolName;
}
function isPermissionUpdateLike(value) {
    return Boolean(value && typeof value === 'object');
}
function isPermissionRuleLike(value) {
    return Boolean(value && typeof value === 'object');
}
function trimmedString(value, maxLen) {
    if (value === undefined || value === null)
        return '';
    if (typeof value !== 'string')
        return '';
    const trimmed = value.trim();
    return trimmed.length <= maxLen ? trimmed : null;
}
