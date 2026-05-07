import { createHash } from 'node:crypto';

import {
  isAdminMcpToolFullName,
  isMyClawMcpWildcardRule,
} from './admin-mcp-tools.js';

const MCP_WILDCARD_RE = /^mcp__[A-Za-z0-9_-]+__\*$/;
const SCOPED_RULE_RE = /^([^()\s]+)\(([^()]*)\)$/;

export function persistentPermissionToolId(allowedRule: string): string {
  const digest = createHash('sha256').update(allowedRule).digest('hex');
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
  if (isMyClawMcpWildcardRule(rule)) {
    return {
      ok: false,
      reason:
        'Persistent MyClaw MCP wildcard grants are not supported; request one exact mcp__myclaw__ tool.',
    };
  }
  const scoped = SCOPED_RULE_RE.exec(rule);
  if (scoped) {
    if (!scoped[1]?.trim() || !scoped[2]?.trim()) {
      return { ok: false, reason: 'Scoped tool rule cannot be empty.' };
    }
    if (isAdminMcpToolFullName(scoped[1].trim())) {
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
