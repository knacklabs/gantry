import { ApplicationError } from '../common/application-error.js';
import {
  isCanonicalBrowserCapabilityRule,
  isGantryFacadeExactToolRule,
  parseReadableScopedToolRule,
  RUN_COMMAND_TOOL_NAME,
} from '../../shared/agent-tool-references.js';
import { isAdminMcpToolFullName } from '../../shared/admin-mcp-tools.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { toolRuleCoversRule } from '../../shared/tool-rule-matcher.js';
import { validateDurableAccessRule } from '../../shared/durable-access-policy.js';
import {
  bashExecutableName,
  formatBashArgv,
  parseBashCommand,
} from '../../shared/bash-command-parser.js';

export interface ToolAccessRequirementPreflightResult {
  toolAccessRequirements: string[];
  missingTools: string[];
}

export function normalizeToolAccessRequirements(
  values: readonly unknown[],
  fieldName = 'toolAccessRequirements',
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const rule = typeof raw === 'string' ? raw.trim() : '';
    if (!rule) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `${fieldName} entries must be non-empty strings.`,
      );
    }
    const validation = validateDurableAccessRule(rule, {
      allowUnknownSemanticCapability: true,
    });
    if (!validation.ok) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `${fieldName} entry "${rule}" is not supported: ${validation.reason}`,
      );
    }
    if (!seen.has(rule)) {
      seen.add(rule);
      out.push(rule);
    }
  }
  return out;
}

export function normalizeRequiredMcpServers(
  values: readonly unknown[],
  fieldName = 'requiredMcpServers',
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const requirement = typeof raw === 'string' ? raw.trim() : '';
    if (!requirement) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `${fieldName} entries must be non-empty strings.`,
      );
    }
    if (!seen.has(requirement)) {
      seen.add(requirement);
      out.push(requirement);
    }
  }
  return out;
}

export function evaluateToolAccessRequirements(input: {
  toolAccessRequirements?: readonly string[];
  effectiveAllowedTools: readonly string[];
}): ToolAccessRequirementPreflightResult {
  const toolAccessRequirements = normalizeToolAccessRequirements(
    input.toolAccessRequirements ?? [],
  );
  const allowed = input.effectiveAllowedTools
    .map((tool) => tool.trim())
    .filter(Boolean);
  const canonicalRequirements: string[] = [];
  const missingTools: string[] = [];
  for (const required of toolAccessRequirements) {
    const matched = matchingAllowedRule(required, allowed);
    if (!matched) {
      missingTools.push(required);
      canonicalRequirements.push(required);
      continue;
    }
    canonicalRequirements.push(matched.canonicalRule);
  }
  return {
    toolAccessRequirements: dedupePreservingOrder(canonicalRequirements),
    missingTools,
  };
}

function matchingAllowedRule(
  required: string,
  allowed: readonly string[],
): { canonicalRule: string } | undefined {
  for (const allowedRule of allowed) {
    if (allowedRule === required || toolRuleCoversRule(allowedRule, required)) {
      return { canonicalRule: required };
    }
    const projectedRequired = absoluteRunCommandRuleForBareExecutableRule(
      allowedRule,
      required,
    );
    if (projectedRequired) {
      return { canonicalRule: projectedRequired };
    }
  }
  return undefined;
}

function absoluteRunCommandRuleForBareExecutableRule(
  allowedRule: string,
  requiredRule: string,
): string | undefined {
  const allowed = parseReadableScopedToolRule(allowedRule);
  const required = parseReadableScopedToolRule(requiredRule);
  if (
    allowed?.toolName !== RUN_COMMAND_TOOL_NAME ||
    required?.toolName !== RUN_COMMAND_TOOL_NAME
  ) {
    return undefined;
  }
  const allowedCommand = parseSingleLeafCommand(allowed.scope);
  const requiredCommand = parseSingleLeafCommand(required.scope);
  if (!allowedCommand || !requiredCommand) return undefined;
  const allowedExecutable = allowedCommand.argv[0] ?? '';
  const requiredExecutable = requiredCommand.argv[0] ?? '';
  if (
    !allowedExecutable.startsWith('/') ||
    requiredExecutable.includes('/') ||
    bashExecutableName(allowedExecutable) !== requiredExecutable
  ) {
    return undefined;
  }
  const projectedRequired = formatRunCommandRequirementArgv([
    allowedExecutable,
    ...requiredCommand.argv.slice(1),
  ]);
  const projectedRule = `${RUN_COMMAND_TOOL_NAME}(${projectedRequired})`;
  return toolRuleCoversRule(allowedRule, projectedRule)
    ? projectedRule
    : undefined;
}

function parseSingleLeafCommand(scope: string) {
  const parsed = parseBashCommand(scope.trim());
  if (!parsed.ok || parsed.leaves.length !== 1) return undefined;
  return parsed.leaves[0];
}

function formatRunCommandRequirementArgv(argv: readonly string[]): string {
  return argv
    .map((arg) => (arg === '*' ? '*' : formatBashArgv([arg])))
    .join(' ');
}

function dedupePreservingOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function toolAccessRequirementRecoveryAction(toolName: string): string {
  const scoped = parseReadableScopedToolRule(toolName);
  if (scoped?.toolName === RUN_COMMAND_TOOL_NAME) {
    return `request_access ${JSON.stringify({
      target: { kind: 'run_command', argvPattern: scoped.scope },
      temporaryOnly: false,
      reason: `This autonomous run requires ${toolName} access.`,
    })}`;
  }
  if (isCanonicalBrowserCapabilityRule(toolName)) {
    return `request_access ${JSON.stringify({
      target: { kind: 'capability', id: 'browser.use' },
      temporaryOnly: false,
      reason: 'This autonomous run requires Browser access.',
    })}`;
  }
  const semanticCapabilityId = parseSemanticCapabilityRule(toolName);
  if (semanticCapabilityId) {
    return `request_access ${JSON.stringify({
      target: { kind: 'capability', id: semanticCapabilityId },
      reason: `This autonomous run requires ${toolName} access.`,
    })}`;
  }
  if (
    isGantryFacadeExactToolRule(toolName) ||
    isAdminMcpToolFullName(toolName)
  ) {
    return `request_access ${JSON.stringify({
      target: { kind: 'tool', name: toolName },
      temporaryOnly: false,
      reason: `This autonomous run requires ${toolName} access.`,
    })}`;
  }
  return [
    'Update the job to require a reviewed semantic capability.',
    'Use request_access target.kind=run_command only for scoped command fallback access.',
  ].join(' ');
}

export function missingToolAccessRequirementError(toolName: string): string {
  return `Missing tool access requirement before run. Tool not on autonomous run allowlist: ${toolName}. Recovery: ${toolAccessRequirementRecoveryAction(toolName)}`;
}
