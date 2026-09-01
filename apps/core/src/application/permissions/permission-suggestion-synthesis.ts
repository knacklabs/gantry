import type {
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
} from '../../domain/types.js';
import {
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from '../../shared/agent-tool-references.js';
import { containsGeneratedRuntimeSkillPath } from '../../shared/generated-runtime-paths.js';
import { synthesizeFamilyRunCommandRuleContents } from '../../shared/family-rule-synthesis.js';
import { permissionUpdateAllowedToolRules } from '../../shared/permission-tool-rules.js';
import { validatePersistentRule } from './permission-management-service.js';

export function synthesizeHostPermissionSuggestions(
  toolName: string,
  toolInput: unknown,
): PermissionApprovalUpdate[] | undefined {
  const publicToolName = publicGantryToolNameForSdkTool(toolName.trim());
  const rules =
    publicToolName === RUN_COMMAND_TOOL_NAME ? commandRules(toolInput) : [];
  const validRules = rules.filter((rule) => {
    try {
      validatePersistentRule(rule);
      return true;
    } catch {
      return false;
    }
  });
  if (validRules.length === 0) return undefined;
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

export function permissionSuggestionKey(
  agentFolder: string,
  suggestions: PermissionApprovalRequest['suggestions'],
): string | undefined {
  const firstRule = permissionUpdateAllowedToolRules(suggestions)[0]?.trim();
  const folder = agentFolder.trim();
  return folder && firstRule ? `${folder}|${firstRule}` : undefined;
}

function commandRules(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const input = toolInput as Record<string, unknown>;
  const command = input.command ?? input.cmd;
  if (typeof command !== 'string') return [];
  const rawCommand = command.trim();
  if (containsGeneratedRuntimeSkillPath(rawCommand)) return [];
  return synthesizeFamilyRunCommandRuleContents(rawCommand).map(
    (rule) => `${RUN_COMMAND_TOOL_NAME}(${rule})`,
  );
}
