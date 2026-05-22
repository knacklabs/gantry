import { ApplicationError } from '../common/application-error.js';
import {
  isCanonicalBrowserCapabilityRule,
  isGantryFacadeExactToolRule,
  isProjectedBrowserMcpToolRule,
  parseReadableScopedToolRule,
  RUN_COMMAND_TOOL_NAME,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import { isGantryMcpWildcardRule } from '../../shared/admin-mcp-tools.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { toolRuleCoversRule } from '../../shared/tool-rule-matcher.js';
import {
  bashExecutableName,
  parseBashCommand,
} from '../../shared/bash-command-parser.js';

const EXACT_GANTRY_MCP_TOOL_RE = /^mcp__gantry__[A-Za-z0-9_-]+$/;

export interface ToolAccessRequirementPreflightResult {
  toolAccessRequirements: string[];
  missingTools: string[];
}

export function normalizeToolAccessRequirementsInput(
  value: unknown,
  fieldName = 'toolAccessRequirements',
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `${fieldName} must be an array of readable tool rules.`,
    );
  }
  return normalizeToolAccessRequirements(value, fieldName);
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
    const validation = validateToolAccessRequirementRule(rule);
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

export function normalizeRequiredMcpServersInput(
  value: unknown,
  fieldName = 'requiredMcpServers',
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `${fieldName} must be an array of MCP server names or ids.`,
    );
  }
  return normalizeRequiredMcpServers(value, fieldName);
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

export function validateToolAccessRequirementRule(
  rule: string,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = rule.trim();
  if (!trimmed) return { ok: false, reason: 'Tool rule cannot be empty.' };
  if (isGantryMcpWildcardRule(trimmed)) {
    return {
      ok: false,
      reason:
        'Gantry MCP wildcard grants are not valid tool access requirements.',
    };
  }
  const readable = validateReadableAgentToolRule(trimmed);
  if (!readable.ok) return readable;
  if (isGantryFacadeExactToolRule(trimmed)) return { ok: true };
  const scoped = parseReadableScopedToolRule(trimmed);
  if (scoped) {
    return scoped.toolName === RUN_COMMAND_TOOL_NAME
      ? { ok: true }
      : {
          ok: false,
          reason: 'Only RunCommand supports scoped tool access requirements.',
        };
  }
  if (parseSemanticCapabilityRule(trimmed)) return { ok: true };
  if (isCanonicalBrowserCapabilityRule(trimmed)) return { ok: true };
  if (
    EXACT_GANTRY_MCP_TOOL_RE.test(trimmed) &&
    !isProjectedBrowserMcpToolRule(trimmed)
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'Use canonical Browser, exact Gantry file/web tool names, capability:<id>, exact mcp__gantry__ tool names, or scoped RunCommand(...).',
  };
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
    if (absoluteRunCommandRuleCoversBareExecutableRule(allowedRule, required)) {
      return { canonicalRule: allowedRule };
    }
  }
  return undefined;
}

function absoluteRunCommandRuleCoversBareExecutableRule(
  allowedRule: string,
  requiredRule: string,
): boolean {
  const allowed = parseReadableScopedToolRule(allowedRule);
  const required = parseReadableScopedToolRule(requiredRule);
  if (
    allowed?.toolName !== RUN_COMMAND_TOOL_NAME ||
    required?.toolName !== RUN_COMMAND_TOOL_NAME
  ) {
    return false;
  }
  const allowedCommand = parseSingleLeafCommand(allowed.scope);
  const requiredCommand = parseSingleLeafCommand(required.scope);
  if (!allowedCommand || !requiredCommand) return false;
  const allowedExecutable = allowedCommand.argv[0] ?? '';
  const requiredExecutable = requiredCommand.argv[0] ?? '';
  if (
    !allowedExecutable.startsWith('/') ||
    requiredExecutable.includes('/') ||
    bashExecutableName(allowedExecutable) !== requiredExecutable
  ) {
    return false;
  }
  const projectedRequired = [
    allowedExecutable,
    ...requiredCommand.argv.slice(1),
  ].join(' ');
  return toolRuleCoversRule(
    allowedRule,
    `${RUN_COMMAND_TOOL_NAME}(${projectedRequired})`,
  );
}

function parseSingleLeafCommand(scope: string) {
  const parsed = parseBashCommand(scope.trim());
  if (!parsed.ok || parsed.leaves.length !== 1) return undefined;
  return parsed.leaves[0];
}

function dedupePreservingOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function toolAccessRequirementRecoveryAction(toolName: string): string {
  const scoped = parseReadableScopedToolRule(toolName);
  if (scoped?.toolName === RUN_COMMAND_TOOL_NAME) {
    return `request_permission ${JSON.stringify({
      permissionKind: 'tool',
      toolName: RUN_COMMAND_TOOL_NAME,
      rule: scoped.scope,
      temporaryOnly: false,
      reason: `This autonomous run requires ${toolName} access.`,
    })}`;
  }
  if (isCanonicalBrowserCapabilityRule(toolName)) {
    return `request_permission ${JSON.stringify({
      permissionKind: 'tool',
      toolName: 'Browser',
      toolCategory: 'browser',
      temporaryOnly: false,
      reason: 'This autonomous run requires Browser access.',
    })}`;
  }
  const semanticCapabilityId = parseSemanticCapabilityRule(toolName);
  if (semanticCapabilityId) {
    return `propose_capability ${JSON.stringify({
      capabilityId: semanticCapabilityId,
      reason: `This autonomous run requires ${toolName} access.`,
    })}`;
  }
  return `request_permission ${JSON.stringify({
    permissionKind: 'tool',
    toolName,
    temporaryOnly: false,
    reason: `This autonomous run requires ${toolName} access.`,
  })}`;
}

export function missingToolAccessRequirementError(toolName: string): string {
  return `Missing tool access requirement before run. Tool not on autonomous run allowlist: ${toolName}. Recovery: ${toolAccessRequirementRecoveryAction(toolName)}`;
}
