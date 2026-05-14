import { createHash } from 'node:crypto';

import {
  nonDurableBashLeafReason,
  parseBashCommand,
  wildcardSensitiveBashLeafReason,
} from './bash-command-parser.js';
import { isMyClawMcpWildcardRule } from './admin-mcp-tools.js';
import {
  parseSemanticCapabilityRule,
  SEMANTIC_CAPABILITY_RULE_PREFIX,
  semanticCapabilityIdValidationReason,
} from './semantic-capability-ids.js';

const MCP_WILDCARD_RE = /^mcp__[A-Za-z0-9_-]+__\*$/;
const HOST_PRIVATE_BROWSER_BACKEND_MCP_SERVER_NAMES = [
  `${'browser'}_${'backend'}`,
  `${'agent'}_${'browser'}`,
  `${'play'}${'wright'}`,
  `${'pup'}${'peteer'}`,
] as const;
const HOST_PRIVATE_BROWSER_BACKEND_MCP_TOOL_PREFIXES =
  HOST_PRIVATE_BROWSER_BACKEND_MCP_SERVER_NAMES.map(
    (serverName) => `mcp__${serverName}__`,
  );
const MYCLAW_BROWSER_TOOL_PREFIX = 'mcp__myclaw__browser';
const BROWSER_CANONICAL_TOOL_NAME = 'Browser';
const BASH_TOOL_NAME = 'Bash';
export const SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME = 'SandboxNetworkAccess';
export const PROJECTED_BROWSER_MCP_TOOL_NAMES = [
  'mcp__myclaw__browser_status',
  'mcp__myclaw__browser_open',
  'mcp__myclaw__browser_inspect',
  'mcp__myclaw__browser_act',
  'mcp__myclaw__browser_close',
] as const;

const PROJECTED_BROWSER_MCP_TOOL_NAME_SET = new Set<string>(
  PROJECTED_BROWSER_MCP_TOOL_NAMES,
);

export const BROWSER_ACTION_MCP_RULE_REJECTION_REASON =
  'Host-private browser backend tools cannot be persisted as agent tool rules; use the canonical Browser tool capability instead.';
export const BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON =
  'MyClaw browser tools are runtime projections, not durable capabilities; persist the canonical Browser tool capability instead.';
export const BASH_SCOPE_REJECTION_REASON =
  'Persistent Bash scope is too broad; include a literal command prefix such as Bash(npm test *).';
export const SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON =
  'SDK sandbox network prompts are internal defense-in-depth callbacks and cannot be persisted as agent tool rules; approve the scoped Bash(...) command instead.';

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
  return HOST_PRIVATE_BROWSER_BACKEND_MCP_TOOL_PREFIXES.some((prefix) =>
    toolName.startsWith(prefix),
  );
}

export function isHostPrivateBrowserMcpServerName(value: string): boolean {
  const serverName = value.trim().toLowerCase();
  if (!serverName) return false;
  const normalized = serverName.replaceAll('-', '_');
  return HOST_PRIVATE_BROWSER_BACKEND_MCP_SERVER_NAMES.some(
    (name) => name === normalized,
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

export function isThirdPartyMcpToolRule(value: string): boolean {
  const rule = value.trim();
  const scoped = parseReadableScopedToolRule(rule);
  const toolName = scoped ? scoped.toolName : rule;
  return (
    toolName.startsWith('mcp__') &&
    !toolName.startsWith('mcp__myclaw__') &&
    !MCP_WILDCARD_RE.test(toolName)
  );
}

export function isKnownProjectedBrowserMcpToolName(value: string): boolean {
  return PROJECTED_BROWSER_MCP_TOOL_NAME_SET.has(value.trim());
}

export function isCanonicalBrowserCapabilityRule(value: string): boolean {
  return value.trim() === BROWSER_CANONICAL_TOOL_NAME;
}

export function isSdkSandboxNetworkAccessToolName(value: string): boolean {
  return value.trim() === SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME;
}

export function isSdkSandboxNetworkAccessToolRule(value: string): boolean {
  const rule = value.trim();
  const scoped = parseReadableScopedToolRule(rule);
  const toolName = scoped ? scoped.toolName : rule;
  return isSdkSandboxNetworkAccessToolName(toolName);
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
        'Tool rule must be readable; use a tool name or scoped Bash rule, not an internal tool ID.',
    };
  }
  if (rule.startsWith(SEMANTIC_CAPABILITY_RULE_PREFIX)) {
    const capabilityId = parseSemanticCapabilityRule(rule);
    if (!capabilityId) {
      return {
        ok: false,
        reason:
          semanticCapabilityIdValidationReason(
            rule.slice(SEMANTIC_CAPABILITY_RULE_PREFIX.length),
          ) ?? 'Invalid semantic capability rule.',
      };
    }
    return { ok: true };
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
  if (isSdkSandboxNetworkAccessToolRule(rule)) {
    return {
      ok: false,
      reason: SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON,
    };
  }
  const scoped = parseReadableScopedToolRule(rule);
  if (scoped) {
    if (!scoped.scope) {
      return { ok: false, reason: 'Scoped tool rule cannot be empty.' };
    }
    if (scoped.toolName !== BASH_TOOL_NAME) {
      return {
        ok: false,
        reason:
          'Only Bash supports persistent scoped tool rules; use an exact tool name for other tools.',
      };
    }
    const bashScope = validatePersistentBashScope(scoped.scope);
    if (!bashScope.ok) return bashScope;
    return { ok: true };
  }
  if (rule.includes('(') || rule.includes(')')) {
    return { ok: false, reason: 'Malformed scoped tool rule.' };
  }
  if (/\s/.test(rule)) {
    return { ok: false, reason: 'Tool rule cannot contain whitespace.' };
  }
  if (rule === BASH_TOOL_NAME) {
    return {
      ok: false,
      reason:
        'Persistent bare Bash grants are too broad; request a scoped Bash(<pattern>) rule.',
    };
  }
  if (MCP_WILDCARD_RE.test(rule)) {
    return {
      ok: false,
      reason:
        'Persistent MCP wildcard tool grants are not supported; request the MCP server capability or one exact MCP tool name.',
    };
  }
  if (rule.includes('*')) {
    return {
      ok: false,
      reason: 'Wildcard persistent tool grants are not supported.',
    };
  }
  return { ok: true };
}

export function validatePersistentBashScope(
  scope: string,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = scope.trim();
  if (!trimmed)
    return { ok: false, reason: 'Scoped tool rule cannot be empty.' };
  const commandPrefix = trimmed.split(/\s+/, 1)[0] ?? '';
  if (
    !/[^\s*]/.test(trimmed) ||
    trimmed.startsWith('*') ||
    commandPrefix.includes('*')
  ) {
    return {
      ok: false,
      reason: BASH_SCOPE_REJECTION_REASON,
    };
  }
  const parseableScope = trimmed.endsWith(' *')
    ? trimmed.slice(0, -2).trim()
    : trimmed.replaceAll(' * ', ' __MYCLAW_ARG_WILDCARD__ ');
  const parsed = parseBashCommand(parseableScope);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.leaves.length !== 1) {
    return {
      ok: false,
      reason:
        'Persistent Bash scopes must contain exactly one simple command leaf; request separate scoped commands.',
    };
  }
  const destructiveRedirect = parsed.leaves[0].redirects.find(
    (redirect) => redirect.destructive,
  );
  if (destructiveRedirect) {
    return {
      ok: false,
      reason:
        'Persistent Bash rules cannot include destructive redirection; use Allow once.',
    };
  }
  const nonDurableReason = nonDurableBashLeafReason(parsed.leaves[0]);
  if (nonDurableReason) return { ok: false, reason: nonDurableReason };
  const wildcardSensitiveReason = wildcardSensitiveBashLeafReason(
    parsed.leaves[0],
    trimmed,
  );
  if (wildcardSensitiveReason) {
    return { ok: false, reason: wildcardSensitiveReason };
  }
  return { ok: true };
}

export function hasBashShellControlSyntax(value: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = quote !== "'";
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      if (quote === '"' && (ch === '`' || (ch === '$' && next === '('))) {
        return true;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (
      ch === '\n' ||
      ch === ';' ||
      ch === '|' ||
      ch === '`' ||
      (ch === '&' && next === '&') ||
      (ch === '$' && next === '(') ||
      isSubshellBoundary(value, i)
    ) {
      return true;
    }
  }

  return false;
}

function isSubshellBoundary(value: string, index: number): boolean {
  const ch = value[index];
  if (ch === '(') {
    const previous = value.slice(0, index).trimEnd().at(-1);
    return previous === undefined || previous === ';' || previous === '|';
  }
  if (ch === ')') {
    const next = value.slice(index + 1).trimStart()[0];
    return next === undefined || next === ';' || next === '|';
  }
  return false;
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
