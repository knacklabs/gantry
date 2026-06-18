import {
  BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  isBrowserActionMcpToolRule,
  isCanonicalBrowserCapabilityRule,
  isKnownProjectedBrowserMcpToolName,
  isProviderNativeExactToolRule,
  isProjectedBrowserMcpToolRule,
  parseReadableScopedToolRule,
  hasBashShellControlSyntax,
  providerNativeToolRejectionReason,
  RUN_COMMAND_TOOL_NAME,
  validatePersistentBashScope,
} from './agent-tool-references.js';
import { isGantryMcpWildcardRule } from './admin-mcp-tools.js';
import {
  type BashCommandLeaf,
  bashExecutableName,
  bashLeafRuleContent,
  normalizePersistentBashRuleContent,
  parseBashCommand,
} from './bash-command-parser.js';
import { canonicalizeGeneratedRuntimeSkillPaths } from './generated-runtime-paths.js';
import { NEUTRAL_CA_TRUST_ENV_KEYS } from './neutral-ca-trust-env.js';

const MCP_WILDCARD_RE = /^mcp__([A-Za-z0-9_-]+)__\*$/;
const MCP_EXACT_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/;
const SAFE_SCRIPT_INTERPRETERS = new Set(['python', 'python3']);

interface ScopedToolSpec {
  fields: readonly string[];
}

const SCOPED_TOOL_REGISTRY: Record<string, ScopedToolSpec> = {
  [RUN_COMMAND_TOOL_NAME]: { fields: ['command', 'cmd'] },
};

const EXACT_GANTRY_TOOL_RUNTIME_MATCHES: Record<string, readonly string[]> = {
  WebSearch: ['WebSearch'],
  WebRead: ['WebFetch'],
  FileSearch: ['Glob', 'Grep'],
  FileRead: ['Read'],
  FileEdit: ['Edit', 'MultiEdit'],
  FileWrite: ['Write'],
  AgentDelegation: [],
};

const REGISTERED_DURABLE_EXACT_TOOLS = new Set(['Browser']);
const GO_DNS_RUNTIME_ASSIGNMENT_RE = /^GODEBUG=netdns=go\s+/;
const TIMEZONE_RUNTIME_ASSIGNMENT_RE = /^TZ=[A-Za-z0-9_+./:-]+\s+/;
const NEUTRAL_CA_RUNTIME_VALUE_RE =
  /^(?:\$NODE_EXTRA_CA_CERTS|\$\{NODE_EXTRA_CA_CERTS\}|"[\$]NODE_EXTRA_CA_CERTS"|"[\$]\{NODE_EXTRA_CA_CERTS\}"|'[\$]NODE_EXTRA_CA_CERTS'|'[\$]\{NODE_EXTRA_CA_CERTS\}')\s+/;
const RUNTIME_NETWORK_ASSIGNMENT_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'GRPC_PROXY',
  'grpc_proxy',
  'GIT_SSH_COMMAND',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'no_proxy',
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
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
  matchedRules?: string[];
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
  if (isGantryMcpWildcardRule(value)) {
    return {
      ok: false,
      reason:
        'Persistent Gantry MCP wildcard grants are not supported; request one exact mcp__gantry__ tool.',
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
    if (parsed.toolName === RUN_COMMAND_TOOL_NAME) {
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
        'Persistent bare Bash grants are provider-native; request a scoped RunCommand(<argv pattern>) rule.',
    };
  }
  if (parsed.toolName === RUN_COMMAND_TOOL_NAME) {
    return {
      ok: false,
      reason:
        'Persistent bare RunCommand grants are too broad; request a scoped RunCommand(<argv pattern>) rule.',
    };
  }
  if (!isRegisteredExactTool(parsed.toolName)) {
    if (isProviderNativeExactToolRule(parsed.toolName)) {
      return {
        ok: false,
        reason: providerNativeToolRejectionReason(parsed.toolName),
      };
    }
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
  return exactToolRuleMatches(parsed.toolName, toolName);
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
    return (
      candidate.kind === 'exact' &&
      exactToolRuleMatches(allowed.toolName, candidate.toolName)
    );
  }
  if (candidate.kind !== 'scoped') return false;
  if (allowed.toolName !== candidate.toolName) return false;
  if (allowed.scope === candidate.scope) return true;
  return (
    allowed.toolName === RUN_COMMAND_TOOL_NAME &&
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
      return { allowed: true, matchedRule: rule, matchedRules: [rule] };
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
        return { allowed: true, matchedRule: rule, matchedRules: [rule] };
      }
      continue;
    }

    if (parsed.kind === 'exact') {
      if (exactToolRuleMatches(parsed.toolName, toolName)) {
        return { allowed: true, matchedRule: rule, matchedRules: [rule] };
      }
      continue;
    }

    if (!scopedToolRuleMatchesRuntimeTool(parsed.toolName, toolName)) continue;
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

export function normalizeRuntimeOwnedBashCommandForMatching(
  command: string,
): string {
  let normalized = canonicalizeGeneratedRuntimeSkillPaths(
    command
      .trim()
      .replace(
        /(["']?)\$\{CLAUDE_PROJECT_DIR\}\/skills\//g,
        (_match, quote: string) => `${quote}skills/`,
      )
      .replace(
        /(["']?)\$CLAUDE_PROJECT_DIR\/skills\//g,
        (_match, quote: string) => `${quote}skills/`,
      ),
  );

  let sawRuntimePrefix = false;
  for (;;) {
    const next = stripOneRuntimeOwnedAssignment(normalized, sawRuntimePrefix);
    if (next === normalized) return normalized;
    if (GO_DNS_RUNTIME_ASSIGNMENT_RE.test(normalized)) {
      sawRuntimePrefix = true;
    }
    normalized = next.trimStart();
  }
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
        'Scoped autonomous tool rule cannot be evaluated for RunCommand; expected one of command, cmd string fields.',
    };
  }
  const parsedCommand = parseBashCommand(
    normalizeRuntimeOwnedBashCommandForMatching(command),
  );
  if (!parsedCommand.ok) {
    const envKeys = leadingAssignmentKeys(
      normalizeRuntimeOwnedBashCommandForMatching(command),
    );
    const detail =
      parsedCommand.reason ===
        'Bash environment assignments are not supported.' && envKeys.length > 0
        ? `${parsedCommand.reason} Leading env keys: ${envKeys.join(', ')}.`
        : parsedCommand.reason;
    return {
      allowed: false,
      reason: `Bash command could not be parsed safely: ${detail}`,
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
        entry.parsed.toolName === RUN_COMMAND_TOOL_NAME &&
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
      reason:
        firstInvalidRuleReason ?? 'No autonomous tool rule matched RunCommand.',
    };
  }
  return {
    allowed: true,
    matchedRule: [...matchedRules].join(', '),
    matchedRules: [...matchedRules],
  };
}

function stripOneRuntimeOwnedAssignment(
  command: string,
  sawRuntimePrefix: boolean,
): string {
  const goDnsNext = command.replace(GO_DNS_RUNTIME_ASSIGNMENT_RE, '');
  if (goDnsNext !== command) return goDnsNext;
  const timezoneNext = command.replace(TIMEZONE_RUNTIME_ASSIGNMENT_RE, '');
  if (timezoneNext !== command) return timezoneNext;
  const networkNext = stripRuntimeNetworkAssignment(command, sawRuntimePrefix);
  if (networkNext !== command) return networkNext;
  for (const key of NEUTRAL_CA_TRUST_ENV_KEYS) {
    if (!command.startsWith(`${key}=`)) continue;
    const value = command.slice(key.length + 1);
    if (!NEUTRAL_CA_RUNTIME_VALUE_RE.test(value)) continue;
    return value.replace(NEUTRAL_CA_RUNTIME_VALUE_RE, '');
  }
  return command;
}

function stripRuntimeNetworkAssignment(
  command: string,
  sawRuntimePrefix: boolean,
): string {
  const assignment = readLeadingAssignment(command);
  if (!assignment) return command;
  const { key } = assignment;
  if (
    !key ||
    (!RUNTIME_NETWORK_ASSIGNMENT_KEYS.has(key) && !sawRuntimePrefix)
  ) {
    return command;
  }
  if (!assignment.quoted || assignment.hasShellExpansion) return command;
  return command.slice(assignment.end);
}

function leadingAssignmentKeys(command: string): string[] {
  const keys: string[] = [];
  let rest = command.trimStart();
  for (;;) {
    const assignment = readLeadingAssignment(rest);
    if (!assignment) return keys;
    keys.push(assignment.key);
    rest = rest.slice(assignment.end).trimStart();
  }
}

function readLeadingAssignment(command: string): {
  key: string;
  end: number;
  quoted: boolean;
  hasShellExpansion: boolean;
} | null {
  const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(command);
  const key = keyMatch?.[1];
  if (!key) return null;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let quoted = false;
  let hasShellExpansion = false;
  for (let index = key.length + 1; index < command.length; index += 1) {
    const ch = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && (ch === '$' || ch === '`')) {
        hasShellExpansion = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoted = true;
      quote = ch;
      continue;
    }
    if (ch === '$' || ch === '`') {
      hasShellExpansion = true;
    }
    if (/\s/.test(ch)) {
      return {
        key,
        end: index + 1,
        quoted,
        hasShellExpansion,
      };
    }
  }
  return null;
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
  return (
    REGISTERED_DURABLE_EXACT_TOOLS.has(toolName) ||
    hasOwn(EXACT_GANTRY_TOOL_RUNTIME_MATCHES, toolName) ||
    MCP_EXACT_RE.test(toolName)
  );
}

function exactToolRuleMatches(ruleToolName: string, runtimeToolName: string) {
  if (!isRegisteredExactTool(ruleToolName)) return false;
  if (ruleToolName === runtimeToolName) return true;
  return (
    EXACT_GANTRY_TOOL_RUNTIME_MATCHES[ruleToolName]?.includes(
      runtimeToolName,
    ) ?? false
  );
}

function scopedToolRuleMatchesRuntimeTool(
  ruleToolName: string,
  runtimeToolName: string,
) {
  return (
    ruleToolName === runtimeToolName ||
    (ruleToolName === RUN_COMMAND_TOOL_NAME && runtimeToolName === 'Bash')
  );
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
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
  const normalizedScope = normalizePersistentBashRuleContent(
    canonicalizeGeneratedRuntimeSkillPaths(scope.trim()),
  );
  const parsedScope = parseBashCommand(normalizedScope);
  if (!parsedScope.ok || parsedScope.leaves.length !== 1) return false;
  const patternArgs = parsedScope.leaves[0]?.argv ?? [];
  if (patternArgs.length === 0) return false;
  if (patternArgs[0].includes('*')) return false;
  const argv = leafArgvForScope(patternArgs, leaf.argv);
  if (!argv) return false;
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

function leafArgvForScope(
  patternArgs: readonly string[],
  leafArgv: readonly string[],
): readonly string[] | null {
  if (leafArgv.length === 0) return null;
  if (globPatternMatches(patternArgs[0]!, leafArgv[0]!)) return leafArgv;
  const interpreter = bashExecutableName(leafArgv[0] ?? '');
  if (!SAFE_SCRIPT_INTERPRETERS.has(interpreter)) return null;
  const scriptArg = leafArgv[1];
  if (!scriptArg || scriptArg.startsWith('-')) return null;
  if (!globPatternMatches(patternArgs[0]!, scriptArg)) return null;
  return [scriptArg, ...leafArgv.slice(2)];
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
