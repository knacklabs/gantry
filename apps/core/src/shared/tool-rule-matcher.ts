import {
  isCanonicalBrowserCapabilityRule,
  isKnownProjectedBrowserMcpToolName,
  parseReadableScopedToolRule,
} from './agent-tool-references.js';

const MCP_WILDCARD_RE = /^mcp__([A-Za-z0-9_-]+)__\*$/;
const MCP_EXACT_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

type ScopeValueKind = 'literal' | 'url';

interface ScopedToolSpec {
  fields: readonly string[];
  valueKind: ScopeValueKind;
}

const SCOPED_TOOL_REGISTRY: Record<string, ScopedToolSpec> = {
  Agent: { fields: ['subagent_type', 'agent_type'], valueKind: 'literal' },
  Bash: { fields: ['command', 'cmd'], valueKind: 'literal' },
  Edit: { fields: ['file_path', 'filePath', 'path'], valueKind: 'literal' },
  Glob: { fields: ['pattern'], valueKind: 'literal' },
  Grep: { fields: ['pattern'], valueKind: 'literal' },
  LS: { fields: ['path'], valueKind: 'literal' },
  MultiEdit: {
    fields: ['file_path', 'filePath', 'path'],
    valueKind: 'literal',
  },
  NotebookEdit: {
    fields: ['notebook_path', 'notebookPath', 'file_path', 'filePath', 'path'],
    valueKind: 'literal',
  },
  Read: { fields: ['file_path', 'filePath', 'path'], valueKind: 'literal' },
  Skill: {
    fields: ['skill', 'skill_name', 'skillName', 'name'],
    valueKind: 'literal',
  },
  ToolSearch: { fields: ['query'], valueKind: 'literal' },
  WebFetch: { fields: ['url'], valueKind: 'url' },
  WebSearch: { fields: ['query'], valueKind: 'literal' },
  Write: { fields: ['file_path', 'filePath', 'path'], valueKind: 'literal' },
};

const REGISTERED_NATIVE_TOOLS = new Set(Object.keys(SCOPED_TOOL_REGISTRY));

type ParsedToolRule =
  | { kind: 'exact'; toolName: string }
  | { kind: 'mcp-wildcard'; serverName: string }
  | { kind: 'scoped'; toolName: string; scope: string };

export interface ToolRuleValidationResult {
  ok: boolean;
  reason?: string;
}

export interface ToolRuleEvaluationResult {
  allowed: boolean;
  matchedRule?: string;
  reason?: string;
}

export function normalizeToolRules(
  rules: readonly unknown[] | undefined,
): string[] {
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rules) {
    const rule = typeof raw === 'string' ? raw.trim() : '';
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
  }
  return out;
}

export function validateAutonomousToolRule(
  rule: string,
): ToolRuleValidationResult {
  const value = rule.trim();
  if (!value) return { ok: false, reason: 'Tool rule cannot be empty.' };
  if (value === '*') {
    return { ok: false, reason: 'Global wildcard tool rule is not allowed.' };
  }
  const parsed = parseToolRule(value);
  if (!parsed) {
    return {
      ok: false,
      reason: 'Malformed scoped tool rule.',
    };
  }
  if (parsed.kind === 'scoped') {
    if (!parsed.scope.trim()) {
      return { ok: false, reason: 'Scoped tool rule cannot be empty.' };
    }
    if (!REGISTERED_NATIVE_TOOLS.has(parsed.toolName)) {
      return {
        ok: false,
        reason: `Scoped tool rule uses unsupported tool ${parsed.toolName}.`,
      };
    }
    return { ok: true };
  }
  if (parsed.kind === 'mcp-wildcard') return { ok: true };
  if (value.includes('*')) {
    return {
      ok: false,
      reason:
        'Wildcard tool rules must use mcp__server__* form or Tool(scope-pattern).',
    };
  }
  if (!isRegisteredExactTool(parsed.toolName)) {
    return {
      ok: false,
      reason: `Unsupported autonomous tool rule ${parsed.toolName}.`,
    };
  }
  return { ok: true };
}

export function validateAutonomousToolRules(
  rules: readonly string[],
): ToolRuleValidationResult {
  for (const rule of rules) {
    const result = validateAutonomousToolRule(rule);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function toolRuleMatches(rule: string, toolName: string): boolean {
  const parsed = parseToolRule(rule.trim());
  if (!parsed) return false;
  if (parsed.kind === 'mcp-wildcard') {
    return toolName.startsWith(`mcp__${parsed.serverName}__`);
  }
  if (parsed.kind === 'scoped') return false;
  return parsed.toolName === toolName;
}

export function anyToolRuleMatches(
  rules: readonly string[],
  toolName: string,
): boolean {
  return rules.some((rule) => toolRuleMatches(rule, toolName));
}

export function toolRuleCoversRule(
  allowedRule: string,
  candidateRule: string,
): boolean {
  const allowed = parseToolRule(allowedRule.trim());
  const candidate = parseToolRule(candidateRule.trim());
  if (!allowed || !candidate) return false;
  if (candidate.kind === 'mcp-wildcard') {
    return (
      allowed.kind === 'mcp-wildcard' &&
      allowed.serverName === candidate.serverName
    );
  }
  if (allowed.kind === 'mcp-wildcard') {
    return (
      candidate.kind === 'exact' &&
      candidate.toolName.startsWith(`mcp__${allowed.serverName}__`)
    );
  }
  if (allowed.kind === 'exact') {
    return allowed.toolName === candidate.toolName;
  }
  if (candidate.kind !== 'scoped') return false;
  return (
    allowed.toolName === candidate.toolName && allowed.scope === candidate.scope
  );
}

export function evaluateAutonomousToolUse(input: {
  rules: readonly string[];
  toolName: string;
  toolInput: unknown;
}): ToolRuleEvaluationResult {
  const toolName = input.toolName.trim();
  if (!toolName) return { allowed: false, reason: 'Tool name is required.' };

  let firstInvalidRuleReason: string | undefined;
  let firstRelevantScopedReason: string | undefined;
  for (const rule of normalizeToolRules(input.rules)) {
    if (
      isCanonicalBrowserCapabilityRule(rule) &&
      isKnownProjectedBrowserMcpToolName(toolName)
    ) {
      return { allowed: true, matchedRule: rule };
    }

    const validation = validateAutonomousToolRule(rule);
    if (!validation.ok) {
      firstInvalidRuleReason ??= `${validation.reason || 'Invalid tool rule'} (${rule})`;
      continue;
    }

    const parsed = parseToolRule(rule);
    if (!parsed) continue;

    if (parsed.kind === 'mcp-wildcard') {
      if (toolName.startsWith(`mcp__${parsed.serverName}__`)) {
        return { allowed: true, matchedRule: rule };
      }
      continue;
    }

    if (parsed.kind === 'exact') {
      if (parsed.toolName === toolName) {
        return { allowed: true, matchedRule: rule };
      }
      continue;
    }

    if (parsed.toolName !== toolName) continue;
    const spec = SCOPED_TOOL_REGISTRY[parsed.toolName];
    if (!spec) {
      firstRelevantScopedReason ??= `Scoped autonomous tool rule uses unsupported tool ${parsed.toolName}.`;
      continue;
    }
    const candidates = scopedCandidateValues(input.toolInput, spec.fields);
    if (candidates.length === 0) {
      firstRelevantScopedReason ??= `Scoped autonomous tool rule ${rule} cannot be evaluated for ${toolName}; expected one of ${spec.fields.join(', ')} string fields.`;
      continue;
    }
    if (
      candidates.some((candidate) =>
        scopePatternMatches(parsed.scope, candidate, spec.valueKind),
      )
    ) {
      return { allowed: true, matchedRule: rule };
    }
    firstRelevantScopedReason ??= `Tool ${toolName} input did not match scoped autonomous rule ${rule}.`;
  }

  return {
    allowed: false,
    reason:
      firstRelevantScopedReason ??
      firstInvalidRuleReason ??
      `No autonomous tool rule matched ${toolName}.`,
  };
}

function parseToolRule(rule: string): ParsedToolRule | null {
  const value = rule.trim();
  if (!value) return null;
  const scoped = parseReadableScopedToolRule(value);
  if (scoped) {
    return {
      kind: 'scoped',
      toolName: scoped.toolName,
      scope: scoped.scope,
    };
  }
  if (value.includes('(') || value.includes(')')) return null;
  const wildcard = MCP_WILDCARD_RE.exec(value);
  if (wildcard) return { kind: 'mcp-wildcard', serverName: wildcard[1] };
  return { kind: 'exact', toolName: value };
}

function isRegisteredExactTool(toolName: string): boolean {
  return REGISTERED_NATIVE_TOOLS.has(toolName) || MCP_EXACT_RE.test(toolName);
}

function scopedCandidateValues(
  toolInput: unknown,
  fields: readonly string[],
): string[] {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const record = toolInput as Record<string, unknown>;
  const values: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
  }
  return values;
}

function scopePatternMatches(
  scope: string,
  candidate: string,
  valueKind: ScopeValueKind,
): boolean {
  const normalizedScope = scope.trim();
  const normalizedCandidate = candidate.trim();
  if (valueKind === 'url' && normalizedScope.startsWith('domain:')) {
    return domainScopeMatches(
      normalizedScope.slice('domain:'.length),
      normalizedCandidate,
    );
  }
  return globPatternMatches(normalizedScope, normalizedCandidate);
}

function domainScopeMatches(
  scopeDomain: string,
  candidateUrl: string,
): boolean {
  const normalizedScope = scopeDomain.trim().toLowerCase();
  if (!normalizedScope) return false;
  if (!URL.canParse(candidateUrl)) return false;
  const hostname = new URL(candidateUrl).hostname.toLowerCase();
  return (
    hostname === normalizedScope || hostname.endsWith(`.${normalizedScope}`)
  );
}

function globPatternMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const regex = new RegExp(
    `^${pattern.split('*').map(escapeRegex).join('.*')}$`,
  );
  return regex.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}
