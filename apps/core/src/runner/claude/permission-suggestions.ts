import {
  isKnownProjectedBrowserMcpToolName,
  isSdkSandboxNetworkAccessToolName,
} from '../../shared/agent-tool-references.js';
import {
  normalizeBashLeafRuleContent,
  nonDurableBashLeafReason,
  parseBashCommand,
} from '../../shared/bash-command-parser.js';
import { permissionUpdateAllowedToolRules } from '../../shared/permission-tool-rules.js';
import { validatePersistentRequestPermissionRule } from '../../shared/persistent-permission-rules.js';

export function synthesizePermissionSuggestions(
  toolName: string,
  options: { blockedPath?: string; toolInput?: unknown },
): unknown[] | undefined {
  const normalizedToolName = permissionRequestToolName(toolName.trim());
  if (!normalizedToolName) return undefined;
  if (isSdkSandboxNetworkAccessToolName(normalizedToolName)) return undefined;
  if (normalizedToolName === 'Browser') {
    return exactToolPermissionSuggestion('Browser');
  }
  if (normalizedToolName === 'Bash') {
    const commands = inferBashRuleContents(options.toolInput);
    if (!commands.length) return undefined;
    const rules = commands.map((command) => `Bash(${command})`);
    if (rules.some((rule) => !validatePersistentRule(rule))) {
      return undefined;
    }
    return scopedToolPermissionSuggestion(
      'Bash',
      commands.map((command) => ({ ruleContent: command })),
    );
  }
  if (!validatePersistentRule(normalizedToolName)) return undefined;
  return exactToolPermissionSuggestion(normalizedToolName);
}

export function scheduledPermissionSuggestions(
  toolName: string,
  sdkSuggestions: readonly unknown[] | undefined,
  options: { blockedPath?: string; toolInput?: unknown },
): unknown[] | undefined {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) return undefined;
  const publicToolName = permissionRequestToolName(normalizedToolName);
  if (isSdkSandboxNetworkAccessToolName(publicToolName)) return undefined;
  if (publicToolName === 'Browser') return browserPermissionSuggestion();
  const normalizedSdkSuggestions =
    normalizePermissionSuggestions(sdkSuggestions);
  if (normalizedSdkSuggestions) return normalizedSdkSuggestions;
  return synthesizePermissionSuggestions(publicToolName, options);
}

function normalizePermissionSuggestions(
  sdkSuggestions: readonly unknown[] | undefined,
): unknown[] | undefined {
  const allowedRules = permissionUpdateAllowedToolRules(sdkSuggestions);
  if (allowedRules.length === 0) return undefined;
  if (allowedRules.some((rule) => !validatePersistentRule(rule))) {
    return undefined;
  }
  if (allowedRules.length === 1) {
    const [rule] = allowedRules;
    if (!rule) return undefined;
    const [toolName, ruleContent] = splitReadableToolRule(rule);
    if (toolName === 'Browser') return browserPermissionSuggestion();
    if (ruleContent)
      return scopedToolPermissionSuggestion(toolName, ruleContent);
    return exactToolPermissionSuggestion(toolName);
  }
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: allowedRules.map((rule) => {
        const [toolName, ruleContent] = splitReadableToolRule(rule);
        return {
          toolName,
          ...(ruleContent ? { ruleContent } : {}),
        };
      }),
    },
  ];
}

export function browserPermissionSuggestion(): unknown[] {
  return exactToolPermissionSuggestion('Browser');
}

function exactToolPermissionSuggestion(toolName: string): unknown[] {
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [
        {
          toolName,
        },
      ],
    },
  ];
}

function scopedToolPermissionSuggestion(
  toolName: string,
  rules: string | Array<{ ruleContent: string }>,
): unknown[] {
  const normalizedRules =
    typeof rules === 'string'
      ? [{ toolName, ruleContent: rules }]
      : rules.map((rule) => ({ toolName, ruleContent: rule.ruleContent }));
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: normalizedRules,
    },
  ];
}

export function permissionRequestToolName(toolName: string): string {
  return isKnownProjectedBrowserMcpToolName(toolName.trim())
    ? 'Browser'
    : toolName;
}

function inferBashRuleContents(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const input = toolInput as Record<string, unknown>;
  const command = input.command ?? input.cmd;
  if (typeof command !== 'string') return [];
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 2048) return [];
  const parsed = parseBashCommand(trimmed);
  if (!parsed.ok) return [];
  if (
    parsed.leaves.some((leaf) =>
      leaf.redirects.some((redirect) => redirect.destructive),
    )
  ) {
    return [];
  }
  if (parsed.leaves.some((leaf) => nonDurableBashLeafReason(leaf))) {
    return [];
  }
  const rules = parsed.leaves
    .map(normalizeBashLeafRuleContent)
    .filter((rule): rule is string => Boolean(rule));
  return [...new Set(rules)];
}

function splitReadableToolRule(rule: string): [string, string | undefined] {
  const open = rule.indexOf('(');
  if (open <= 0 || !rule.endsWith(')')) return [rule, undefined];
  return [rule.slice(0, open), rule.slice(open + 1, -1)];
}

function validatePersistentRule(rule: string): boolean {
  return validatePersistentRequestPermissionRule(rule).ok;
}
