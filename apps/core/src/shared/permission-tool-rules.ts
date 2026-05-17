import { normalizePersistentBashRuleContent } from './bash-command-parser.js';

export interface PermissionRuleLike {
  toolName?: unknown;
  ruleContent?: unknown;
}

export interface PermissionUpdateLike {
  type?: unknown;
  behavior?: unknown;
  rules?: unknown;
}

export function permissionUpdateAllowedToolRules(
  updates: readonly unknown[] | undefined,
): string[] {
  const out = new Set<string>();
  for (const update of updates ?? []) {
    if (!isPermissionUpdateLike(update)) continue;
    if (update.type !== 'addRules' && update.type !== 'replaceRules') {
      continue;
    }
    if (update.behavior !== 'allow') continue;
    const rules = Array.isArray(update.rules) ? update.rules : [];
    for (const rule of rules) {
      const allowedRule = permissionRuleAllowedToolRule(rule);
      if (allowedRule) out.add(allowedRule);
    }
  }
  return [...out];
}

export function persistentPermissionUpdates(decision: {
  approved?: boolean;
  mode?: string | null;
  decisionClassification?: string | null;
  updatedPermissions?: readonly unknown[];
}): readonly unknown[] | undefined {
  if (
    decision.approved !== true ||
    decision.mode !== 'allow_persistent_rule' ||
    decision.decisionClassification !== 'user_permanent'
  ) {
    return undefined;
  }
  return decision.updatedPermissions;
}

function permissionRuleAllowedToolRule(rule: unknown): string | null {
  if (!isPermissionRuleLike(rule)) return null;
  const toolName = trimmedString(rule.toolName, 120);
  if (!toolName) return null;
  if (toolName.includes('(') || toolName.includes(')')) return null;
  const ruleContent = trimmedString(rule.ruleContent, 2048);
  if (ruleContent === null) return null;
  const normalizedRuleContent =
    toolName === 'Bash' && ruleContent
      ? normalizePersistentBashRuleContent(ruleContent)
      : ruleContent;
  return normalizedRuleContent
    ? `${toolName}(${normalizedRuleContent})`
    : toolName;
}

function isPermissionUpdateLike(value: unknown): value is PermissionUpdateLike {
  return Boolean(value && typeof value === 'object');
}

function isPermissionRuleLike(value: unknown): value is PermissionRuleLike {
  return Boolean(value && typeof value === 'object');
}

function trimmedString(value: unknown, maxLen: number): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= maxLen ? trimmed : null;
}
