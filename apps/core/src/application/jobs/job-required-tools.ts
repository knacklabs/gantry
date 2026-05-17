import { ApplicationError } from '../common/application-error.js';
import {
  isCanonicalBrowserCapabilityRule,
  isProjectedBrowserMcpToolRule,
  parseReadableScopedToolRule,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import { isMyClawMcpWildcardRule } from '../../shared/admin-mcp-tools.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { toolRuleCoversRule } from '../../shared/tool-rule-matcher.js';

const EXACT_MYCLAW_MCP_TOOL_RE = /^mcp__myclaw__[A-Za-z0-9_-]+$/;

export interface RequiredToolPreflightResult {
  requiredTools: string[];
  missingTools: string[];
}

export function normalizeRequiredToolsInput(
  value: unknown,
  fieldName = 'requiredTools',
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `${fieldName} must be an array of readable tool rules.`,
    );
  }
  return normalizeRequiredTools(value, fieldName);
}

export function normalizeRequiredTools(
  values: readonly unknown[],
  fieldName = 'requiredTools',
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
    const validation = validateRequiredToolRule(rule);
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

export function validateRequiredToolRule(
  rule: string,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = rule.trim();
  if (!trimmed) return { ok: false, reason: 'Tool rule cannot be empty.' };
  if (isMyClawMcpWildcardRule(trimmed)) {
    return {
      ok: false,
      reason:
        'MyClaw MCP wildcard grants are not valid required-tool assertions.',
    };
  }
  const readable = validateReadableAgentToolRule(trimmed);
  if (!readable.ok) return readable;
  const scoped = parseReadableScopedToolRule(trimmed);
  if (scoped) {
    return scoped.toolName === 'Bash'
      ? { ok: true }
      : {
          ok: false,
          reason: 'Only Bash supports scoped required-tool assertions.',
        };
  }
  if (parseSemanticCapabilityRule(trimmed)) return { ok: true };
  if (isCanonicalBrowserCapabilityRule(trimmed)) return { ok: true };
  if (
    EXACT_MYCLAW_MCP_TOOL_RE.test(trimmed) &&
    !isProjectedBrowserMcpToolRule(trimmed)
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'Use canonical Browser, capability:<id>, exact mcp__myclaw__ tool names, or scoped Bash(...).',
  };
}

export function evaluateRequiredTools(input: {
  requiredTools?: readonly string[];
  effectiveAllowedTools: readonly string[];
}): RequiredToolPreflightResult {
  const requiredTools = normalizeRequiredTools(input.requiredTools ?? []);
  const allowed = input.effectiveAllowedTools
    .map((tool) => tool.trim())
    .filter(Boolean);
  const missingTools = requiredTools.filter(
    (required) =>
      !allowed.some(
        (allowedRule) =>
          allowedRule === required || toolRuleCoversRule(allowedRule, required),
      ),
  );
  return { requiredTools, missingTools };
}

export function requiredToolRecoveryAction(toolName: string): string {
  if (isCanonicalBrowserCapabilityRule(toolName)) {
    return `request_permission ${JSON.stringify({
      permissionKind: 'tool',
      toolName: 'Browser',
      toolCategory: 'browser',
      temporaryOnly: false,
      reason: 'This autonomous run requires Browser.',
    })}`;
  }
  if (parseSemanticCapabilityRule(toolName)) {
    return `request_permission ${JSON.stringify({
      permissionKind: 'tool',
      toolName,
      temporaryOnly: false,
      reason: `This autonomous run requires ${toolName}.`,
    })}`;
  }
  return `request_permission ${JSON.stringify({
    permissionKind: 'tool',
    toolName,
    temporaryOnly: false,
    reason: `This autonomous run requires ${toolName}.`,
  })}`;
}

export function missingRequiredToolError(toolName: string): string {
  return `Missing required tool before run. Tool not on autonomous run allowlist: ${toolName}. Recovery: ${requiredToolRecoveryAction(toolName)}`;
}
