import { createHash } from 'node:crypto';

import {
  isAdminMcpToolFullName,
  isMyClawMcpWildcardRule,
} from './admin-mcp-tools.js';

const MCP_WILDCARD_RE = /^mcp__[A-Za-z0-9_-]+__\*$/;
const RAW_BROWSER_BACKEND_MCP_TOOL_PREFIXES = [
  'mcp__agent_browser__',
  'mcp__playwright__',
  'mcp__puppeteer__',
] as const;
const MYCLAW_BROWSER_TOOL_PREFIX = 'mcp__myclaw__browser';
const BROWSER_CANONICAL_TOOL_NAME = 'Browser';
export const PROJECTED_BROWSER_MCP_TOOL_NAMES = [
  'mcp__myclaw__browser_status',
  'mcp__myclaw__browser_launch',
  'mcp__myclaw__browser_close',
  'mcp__myclaw__browser_click',
  'mcp__myclaw__browser_console_messages',
  'mcp__myclaw__browser_drag',
  'mcp__myclaw__browser_drop',
  'mcp__myclaw__browser_evaluate',
  'mcp__myclaw__browser_file_upload',
  'mcp__myclaw__browser_fill_form',
  'mcp__myclaw__browser_handle_dialog',
  'mcp__myclaw__browser_hover',
  'mcp__myclaw__browser_navigate',
  'mcp__myclaw__browser_navigate_back',
  'mcp__myclaw__browser_network_requests',
  'mcp__myclaw__browser_press_key',
  'mcp__myclaw__browser_resize',
  'mcp__myclaw__browser_select_option',
  'mcp__myclaw__browser_snapshot',
  'mcp__myclaw__browser_take_screenshot',
  'mcp__myclaw__browser_tabs',
  'mcp__myclaw__browser_type',
  'mcp__myclaw__browser_wait_for',
] as const;

const PROJECTED_BROWSER_MCP_TOOL_NAME_SET = new Set<string>(
  PROJECTED_BROWSER_MCP_TOOL_NAMES,
);

export const BROWSER_ACTION_MCP_RULE_REJECTION_REASON =
  'Raw browser backend MCP tools are host-private and cannot be persisted as agent tool rules; use the canonical Browser tool capability instead.';
export const BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON =
  'Concrete MyClaw browser tools are runtime projections, not durable capabilities; persist the canonical Browser tool capability instead.';

export function parseReadableScopedToolRule(
  value: string,
): { toolName: string; scope: string } | null {
  const rule = value.trim();
  const open = rule.indexOf('(');
  if (open <= 0 || !rule.endsWith(')')) return null;
  const toolName = rule.slice(0, open).trim();
  const scope = rule.slice(open + 1, -1).trim();
  if (!toolName || /\s/.test(toolName)) return null;
  return { toolName, scope };
}

export function isBrowserActionMcpToolRule(value: string): boolean {
  const rule = value.trim();
  const scoped = parseReadableScopedToolRule(rule);
  const toolName = scoped ? scoped.toolName : rule;
  return RAW_BROWSER_BACKEND_MCP_TOOL_PREFIXES.some((prefix) =>
    toolName.startsWith(prefix),
  );
}

export function isProjectedBrowserMcpToolRule(value: string): boolean {
  const rule = value.trim();
  const scoped = parseReadableScopedToolRule(rule);
  const toolName = scoped ? scoped.toolName : rule;
  return (
    toolName === MYCLAW_BROWSER_TOOL_PREFIX ||
    toolName.startsWith(`${MYCLAW_BROWSER_TOOL_PREFIX}_`)
  );
}

export function isKnownProjectedBrowserMcpToolName(value: string): boolean {
  return PROJECTED_BROWSER_MCP_TOOL_NAME_SET.has(value.trim());
}

export function isCanonicalBrowserCapabilityRule(value: string): boolean {
  return value.trim() === BROWSER_CANONICAL_TOOL_NAME;
}

export function persistentPermissionToolId(
  appId: string,
  allowedRule: string,
): string {
  const digest = createHash('sha256')
    .update(`${appId}\0${allowedRule}`)
    .digest('hex');
  return `tool:permission-rule:${digest}`;
}

export function displayToolReference(input: {
  toolId: unknown;
  tool?: { name?: string | null } | null;
}): string {
  const name = input.tool?.name?.trim();
  if (name) return name;
  const value = String(input.toolId).trim();
  if (value.startsWith('tool:')) return value.slice('tool:'.length);
  return value;
}

export function validateReadableAgentToolRule(
  value: string,
): { ok: true } | { ok: false; reason: string } {
  const rule = value.trim();
  if (!rule) return { ok: false, reason: 'Tool rule cannot be empty.' };
  if (isBrowserAliasOrScopedRule(rule)) {
    return {
      ok: false,
      reason:
        'Browser grants must use the exact canonical Browser capability with no scope, alias, or internal ID.',
    };
  }
  if (rule.startsWith('tool:')) {
    return {
      ok: false,
      reason:
        'Tool rule must be readable; use a tool name or scoped rule, not an internal tool ID.',
    };
  }
  if (rule === '*') {
    return { ok: false, reason: 'Global wildcard tool rule is not allowed.' };
  }
  if (isBrowserActionMcpToolRule(rule)) {
    return {
      ok: false,
      reason: BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
    };
  }
  if (isProjectedBrowserMcpToolRule(rule)) {
    return {
      ok: false,
      reason: BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
    };
  }
  if (isMyClawMcpWildcardRule(rule)) {
    return {
      ok: false,
      reason:
        'Persistent MyClaw MCP wildcard grants are not supported; request one exact mcp__myclaw__ tool.',
    };
  }
  const scoped = parseReadableScopedToolRule(rule);
  if (scoped) {
    if (!scoped.scope) {
      return { ok: false, reason: 'Scoped tool rule cannot be empty.' };
    }
    if (isAdminMcpToolFullName(scoped.toolName)) {
      return {
        ok: false,
        reason:
          'Persistent MyClaw admin MCP tool grants must use the exact tool name without a scoped rule.',
      };
    }
    return { ok: true };
  }
  if (rule.includes('(') || rule.includes(')')) {
    return { ok: false, reason: 'Malformed scoped tool rule.' };
  }
  if (/\s/.test(rule)) {
    return { ok: false, reason: 'Tool rule cannot contain whitespace.' };
  }
  if (rule.includes('*') && !MCP_WILDCARD_RE.test(rule)) {
    return {
      ok: false,
      reason:
        'Wildcard tool rules must use mcp__server__* form or Tool(scope-pattern).',
    };
  }
  return { ok: true };
}

function isBrowserAliasOrScopedRule(rule: string): boolean {
  if (rule === BROWSER_CANONICAL_TOOL_NAME) return false;
  const scoped = parseReadableScopedToolRule(rule);
  const toolName = scoped ? scoped.toolName : rule;
  const normalized = toolName.toLowerCase();
  return (
    normalized === BROWSER_CANONICAL_TOOL_NAME.toLowerCase() ||
    normalized === `tool:${BROWSER_CANONICAL_TOOL_NAME.toLowerCase()}`
  );
}
