import {
  BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  isBrowserActionMcpToolRule,
  isCanonicalBrowserCapabilityRule,
  isKnownProjectedBrowserMcpToolName,
  isProjectedBrowserMcpToolRule,
  parseReadableScopedToolRule,
  hasBashShellControlSyntax,
  validatePersistentBashScope,
} from './agent-tool-references.js';
import { isMyClawMcpWildcardRule } from './admin-mcp-tools.js';
import {
  type BashCommandLeaf,
  bashLeafRuleContent,
  parseBashCommand,
} from './bash-command-parser.js';

const MCP_WILDCARD_RE = /^mcp__([A-Za-z0-9_-]+)__\*$/;
const MCP_EXACT_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

interface ScopedToolSpec {
  fields: readonly string[];
}

const SCOPED_TOOL_REGISTRY: Record<string, ScopedToolSpec> = {
  Bash: { fields: ['command', 'cmd'] },
};

const REGISTERED_NATIVE_TOOLS = new Set([
  'Agent',
  'Bash',
  'Browser',
  'Edit',
  'Glob',
  'Grep',
  'LS',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Skill',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
]);

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
  closestRule?: {
    rule: string;
    reason: string;
  };
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
  if (isBrowserActionMcpToolRule(value)) {
    return { ok: false, reason: BROWSER_ACTION_MCP_RULE_REJECTION_REASON };
  }
  if (isProjectedBrowserMcpToolRule(value)) {
    return { ok: false, reason: BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON };
  }
  if (isMyClawMcpWildcardRule(value)) {
    return {
      ok: false,
      reason:
        'Persistent MyClaw MCP wildcard grants are not supported; request one exact mcp__myclaw__ tool.',
    };
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
    if (!SCOPED_TOOL_REGISTRY[parsed.toolName]) {
      return {
        ok: false,
        reason: `Scoped tool rule uses unsupported tool ${parsed.toolName}.`,
      };
    }
    if (parsed.toolName === 'Bash') {
      const bashScope = validatePersistentBashScope(parsed.scope);
      if (!bashScope.ok) return bashScope;
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
  if (parsed.toolName === 'Bash') {
    return {
      ok: false,
      reason:
        'Persistent bare Bash grants are too broad; request a scoped Bash(<pattern>) rule.',
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
  if (allowed.toolName !== candidate.toolName) return false;
  if (allowed.scope === candidate.scope) return true;
  return (
    allowed.toolName === 'Bash' &&
    bashScopeCoversScope(allowed.scope, candidate.scope)
  );
}

export function evaluateAutonomousToolUse(input: {
  rules: readonly string[];
  toolName: string;
  toolInput?: unknown;
}): ToolRuleEvaluationResult {
  const toolName = input.toolName.trim();
  if (!toolName) return { allowed: false, reason: 'Tool name is required.' };
  if (toolName === 'Bash') {
    return evaluateBashToolUse({
      rules: normalizeToolRules(input.rules),
      toolInput: input.toolInput,
    });
  }

  let firstInvalidRuleReason: string | undefined;
  let firstRelevantScopedReason: string | undefined;
  let closestRule: ToolRuleEvaluationResult['closestRule'];
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
      const reason = `Scoped autonomous tool rule uses unsupported tool ${parsed.toolName}.`;
      firstRelevantScopedReason ??= reason;
      closestRule ??= { rule, reason };
      continue;
    }
    const candidates = scopedCandidateValues(input.toolInput, spec.fields);
    if (candidates.length === 0) {
      const reason = `Scoped autonomous tool rule cannot be evaluated for ${toolName}; expected one of ${spec.fields.join(', ')} string fields.`;
      firstRelevantScopedReason ??= reason;
      closestRule ??= { rule, reason };
      continue;
    }
    if (
      candidates.some((candidate) =>
        scopePatternMatches(parsed.scope, candidate),
      )
    ) {
      return { allowed: true, matchedRule: rule };
    }
    const reason = `Tool ${toolName} input did not match scoped autonomous rule.`;
    firstRelevantScopedReason ??= reason;
    closestRule ??= { rule, reason };
  }

  return {
    allowed: false,
    ...(closestRule ? { closestRule } : {}),
    reason:
      firstRelevantScopedReason ??
      firstInvalidRuleReason ??
      `No autonomous tool rule matched ${toolName}.`,
  };
}

function evaluateBashToolUse(input: {
  rules: readonly string[];
  toolInput?: unknown;
}): ToolRuleEvaluationResult {
  const candidates = scopedCandidateValues(input.toolInput, ['command', 'cmd']);
  const command = candidates[0];
  if (!command) {
    return {
      allowed: false,
      reason:
        'Scoped autonomous tool rule cannot be evaluated for Bash; expected one of command, cmd string fields.',
    };
  }
  const parsedCommand = parseBashCommand(command);
  if (!parsedCommand.ok) {
    return {
      allowed: false,
      reason: `Bash command could not be parsed safely: ${parsedCommand.reason}`,
    };
  }
  const parsedRules = input.rules
    .map((rule) => ({ rule, parsed: parseToolRule(rule) }))
    .filter(
      (
        entry,
      ): entry is {
        rule: string;
        parsed: Extract<ParsedToolRule, { kind: 'scoped' }>;
      } =>
        entry.parsed?.kind === 'scoped' &&
        entry.parsed.toolName === 'Bash' &&
        validateAutonomousToolRule(entry.rule).ok,
    );
  let firstInvalidRuleReason: string | undefined;
  for (const rule of input.rules) {
    const validation = validateAutonomousToolRule(rule);
    if (!validation.ok) {
      firstInvalidRuleReason ??= `${validation.reason || 'Invalid tool rule'} (${rule})`;
    }
  }

  const matchedRules = new Set<string>();
  for (const leaf of parsedCommand.leaves) {
    const destructiveRedirect = leaf.redirects.find(
      (redirect) => redirect.destructive,
    );
    if (destructiveRedirect) {
      return {
        allowed: false,
        reason: `Redirect: ${destructiveRedirect.operator} ${destructiveRedirect.target}`,
      };
    }
    const matched = parsedRules.find((entry) =>
      bashScopeMatchesLeaf(entry.parsed.scope, leaf),
    );
    if (!matched) {
      const nearestRule = parsedRules[0]?.rule;
      const reason = `Bash leaf ${bashLeafRuleContent(leaf)} did not match any scoped autonomous rule.`;
      return {
        allowed: false,
        ...(nearestRule ? { closestRule: { rule: nearestRule, reason } } : {}),
        reason,
      };
    }
    matchedRules.add(matched.rule);
  }
  if (parsedCommand.leaves.length === 0) {
    return { allowed: false, reason: 'Bash command has no executable leaves.' };
  }
  if (matchedRules.size === 0) {
    return {
      allowed: false,
      reason: firstInvalidRuleReason ?? 'No autonomous tool rule matched Bash.',
    };
  }
  return {
    allowed: true,
    matchedRule: [...matchedRules].join(', '),
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

function scopePatternMatches(scope: string, candidate: string): boolean {
  const normalizedScope = scope.trim();
  const normalizedCandidate = candidate.trim();
  if (
    normalizedScope.includes('*') &&
    hasBashShellControlSyntax(normalizedCandidate)
  ) {
    return false;
  }
  return globPatternMatches(normalizedScope, normalizedCandidate);
}

function bashScopeMatchesLeaf(scope: string, leaf: BashCommandLeaf): boolean {
  const parsedScope = parseBashCommand(scope.trim());
  if (!parsedScope.ok || parsedScope.leaves.length !== 1) return false;
  const patternArgs = parsedScope.leaves[0]?.argv ?? [];
  if (patternArgs.length === 0) return false;
  if (patternArgs[0].includes('*')) return false;
  const argv = leaf.argv;
  const hasTrailingRestWildcard = patternArgs.at(-1) === '*';
  if (hasTrailingRestWildcard) {
    if (argv.length < patternArgs.length - 1) return false;
  } else if (argv.length !== patternArgs.length) {
    return false;
  }
  for (let index = 0; index < patternArgs.length; index += 1) {
    const pattern = patternArgs[index];
    if (pattern === '*' && index === patternArgs.length - 1) return true;
    const value = argv[index];
    if (value === undefined) return false;
    if (pattern === '*') continue;
    if (!globPatternMatches(pattern, value)) return false;
  }
  return argv.length === patternArgs.length || hasTrailingRestWildcard;
}

function bashScopeCoversScope(allowedScope: string, candidateScope: string) {
  const candidate = parseBashCommand(candidateScope.trim());
  if (!candidate.ok || candidate.leaves.length !== 1) return false;
  return bashScopeMatchesLeaf(allowedScope, candidate.leaves[0]);
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
