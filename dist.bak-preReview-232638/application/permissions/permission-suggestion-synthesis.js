import { publicGantryToolNameForSdkTool, RUN_COMMAND_TOOL_NAME, } from '../../shared/agent-tool-references.js';
import { normalizeBashLeafRuleContent, nonDurableBashLeafReason, parseBashCommand, } from '../../shared/bash-command-parser.js';
import { containsGeneratedRuntimeSkillPath } from '../../shared/generated-runtime-paths.js';
import { permissionUpdateAllowedToolRules } from '../../shared/permission-tool-rules.js';
import { normalizeRuntimeOwnedBashCommandForMatching } from '../../shared/tool-rule-matcher.js';
import { validatePersistentRule } from './permission-management-service.js';
export function synthesizeHostPermissionSuggestions(toolName, toolInput) {
    const publicToolName = publicGantryToolNameForSdkTool(toolName.trim());
    const rules = publicToolName === RUN_COMMAND_TOOL_NAME ? commandRules(toolInput) : [];
    const validRules = rules.filter((rule) => {
        try {
            validatePersistentRule(rule);
            return true;
        }
        catch {
            return false;
        }
    });
    if (validRules.length === 0)
        return undefined;
    return [
        {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: validRules.map((rule) => {
                const open = rule.indexOf('(');
                return open > 0 && rule.endsWith(')')
                    ? {
                        toolName: rule.slice(0, open),
                        ruleContent: rule.slice(open + 1, -1),
                    }
                    : { toolName: rule };
            }),
        },
    ];
}
export function permissionSuggestionKey(agentFolder, suggestions) {
    const firstRule = permissionUpdateAllowedToolRules(suggestions)[0]?.trim();
    const folder = agentFolder.trim();
    return folder && firstRule ? `${folder}|${firstRule}` : undefined;
}
function commandRules(toolInput) {
    if (!toolInput || typeof toolInput !== 'object')
        return [];
    const input = toolInput;
    const command = input.command ?? input.cmd;
    if (typeof command !== 'string')
        return [];
    const rawCommand = command.trim();
    if (containsGeneratedRuntimeSkillPath(rawCommand))
        return [];
    const normalized = normalizeRuntimeOwnedBashCommandForMatching(rawCommand);
    if (!normalized || normalized.length > 2_048)
        return [];
    const parsed = parseBashCommand(normalized);
    if (!parsed.ok)
        return [];
    if (parsed.leaves.some((leaf) => leaf.redirects.some((redirect) => redirect.destructive) ||
        Boolean(nonDurableBashLeafReason(leaf)))) {
        return [];
    }
    return [
        ...new Set(parsed.leaves.flatMap((leaf) => {
            const rule = normalizeBashLeafRuleContent(leaf);
            return rule ? [`${RUN_COMMAND_TOOL_NAME}(${rule})`] : [];
        })),
    ];
}
