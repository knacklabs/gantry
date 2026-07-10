import {
  isRunCommandToolRule,
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from './gantry-tool-facades.js';
import { isCanonicalBrowserCapabilityRule } from './agent-tool-references.js';

export type AgentRuntime = 'worker' | 'inline';

const FILESYSTEM_TOOL_NAMES = new Set([
  'FileSearch',
  'FileRead',
  'FileEdit',
  'FileWrite',
]);

export function inlineWorkerOnlyToolRuleLabels(
  rules: readonly string[],
): string[] {
  return [...new Set(rules.filter(isInlineWorkerOnlyToolRule))].sort();
}

export function formatInlineAgentWorkerOnlyConfigError(
  subject: string,
  labels: readonly string[],
): string {
  return `${subject}.runtime inline is incompatible with worker-only capabilities: ${labels.join(', ')}`;
}

export function isInlineWorkerOnlyToolRule(rule: string): boolean {
  if (isCanonicalBrowserCapabilityRule(rule)) return true;
  if (isRunCommandToolRule(rule)) return true;
  const publicName = publicGantryToolNameForSdkTool(ruleHeadName(rule));
  return (
    publicName === RUN_COMMAND_TOOL_NAME ||
    FILESYSTEM_TOOL_NAMES.has(publicName)
  );
}

function ruleHeadName(rule: string): string {
  const trimmed = rule.trim();
  const open = trimmed.indexOf('(');
  return (open >= 0 ? trimmed.slice(0, open) : trimmed).trim();
}
