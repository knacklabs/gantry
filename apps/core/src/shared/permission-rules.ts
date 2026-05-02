export type PermissionRuleEffect = 'allow' | 'deny';

export interface PermissionRuleSet {
  allow: string[];
  // Deny is admin-authored policy. The chat approval UX never creates deny
  // rules; a rejected request only rejects that request.
  deny: string[];
}

export interface CanonicalPermissionRule {
  toolName: string;
  rule?: string;
  canonical: string;
  broad: boolean;
  risk: 'low' | 'medium' | 'high';
  riskReason: string;
  examples: string[];
  boundary: string;
}

const TOOL_NAMES = new Set([
  'Agent',
  'AskUserQuestion',
  'Browser',
  'Bash',
  'Config',
  'Edit',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListMcpResources',
  'NotebookEdit',
  'Read',
  'ReadMcpResource',
  'Skill',
  'TaskOutput',
  'TaskStop',
  'ToolSearch',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]);

const HIGH_RISK_WHOLE_TOOLS = new Set([
  'Bash',
  'Config',
  'Edit',
  'NotebookEdit',
  'Write',
]);
const WORKSPACE_MUTATING_TOOLS = new Set([
  'Bash',
  'Edit',
  'NotebookEdit',
  'TodoWrite',
  'Write',
]);
const READ_OR_QUERY_TOOLS = new Set([
  'Glob',
  'Grep',
  'ListMcpResources',
  'Read',
  'ReadMcpResource',
  'TaskOutput',
  'TaskStop',
  'WebFetch',
  'WebSearch',
]);

const DEFAULT_PERMISSION_RULES: PermissionRuleSet = {
  allow: [],
  deny: [],
};

export function emptyPermissionRules(): PermissionRuleSet {
  return {
    allow: [],
    deny: [],
  };
}

export function normalizePermissionRules(
  input?: Partial<PermissionRuleSet>,
): PermissionRuleSet {
  const normalized = {
    allow: uniqueRules(input?.allow ?? []),
    deny: uniqueRules(input?.deny ?? []),
  };
  const denied = new Set(normalized.deny);
  const conflict = normalized.allow.find((rule) => denied.has(rule));
  if (conflict) {
    throw new Error(
      `permission rule ${conflict} cannot appear in both allow and deny`,
    );
  }
  return normalized;
}

export function hasPermissionRules(input?: PermissionRuleSet): boolean {
  const rules = input ?? DEFAULT_PERMISSION_RULES;
  return rules.allow.length > 0 || rules.deny.length > 0;
}

export function appendPermissionRule(
  rules: PermissionRuleSet | undefined,
  effect: PermissionRuleEffect,
  rule: string,
): PermissionRuleSet {
  const next = normalizePermissionRules(rules);
  next[effect] = uniqueRules([...next[effect], rule]);
  return next;
}

export function permissionRuleMatchesToolUse(
  canonical: string,
  toolName: string,
  input: unknown,
): boolean {
  const parsed = parseCanonicalPermissionRule(canonical);
  if (!parsed) return false;
  if (parsed.toolName.startsWith('mcp__')) {
    return wildcardMatch(parsed.toolName, toolName);
  }
  if (parsed.toolName !== normalizeToolName(toolName)) return false;
  if (!parsed.rule) return true;
  const value = toolMatchValue(parsed.toolName, input);
  return value ? wildcardMatch(parsed.rule, value) : false;
}

export function canonicalizePermissionRule(input: {
  toolName: string;
  rule?: string;
}): CanonicalPermissionRule {
  const toolName = normalizeToolName(input.toolName);
  const rawRule = normalizeRuleText(input.rule);
  const canonical =
    rawRule && !isBroadScope(rawRule) ? `${toolName}(${rawRule})` : toolName;
  validateCanonicalPermissionRule(canonical);
  return describeCanonicalPermissionRule(canonical);
}

export function validateCanonicalPermissionRule(rule: string): void {
  const parsed = parseCanonicalPermissionRule(rule);
  if (!parsed) {
    throw new Error(
      'permission rule must be a known tool, a scoped rule like Tool(scope), or an MCP pattern like mcp__github__*',
    );
  }
}

export function describeCanonicalPermissionRule(
  canonical: string,
): CanonicalPermissionRule {
  const parsed = parseCanonicalPermissionRule(canonical);
  if (!parsed) {
    throw new Error(`Invalid permission rule: ${canonical}`);
  }
  const broad = !parsed.rule;
  const risk = ruleRisk(parsed.toolName, parsed.rule);
  return {
    toolName: parsed.toolName,
    ...(parsed.rule ? { rule: parsed.rule } : {}),
    canonical,
    broad,
    risk: risk.level,
    riskReason: risk.reason,
    examples: ruleExamples(parsed.toolName, parsed.rule),
    boundary: ruleBoundary(parsed.toolName, parsed.rule),
  };
}

function normalizeToolName(value: string): string {
  const toolName = value.trim();
  if (!toolName) throw new Error('toolName is required');
  if (toolName.startsWith('mcp__')) return normalizeMcpPattern(toolName);
  const match = [...TOOL_NAMES].find(
    (candidate) => candidate.toLowerCase() === toolName.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Unsupported toolName "${toolName}". Use a supported SDK tool or an mcp__server__tool pattern.`,
    );
  }
  return match;
}

function normalizeRuleText(value?: string): string | undefined {
  const rule = value?.trim();
  if (!rule) return undefined;
  if (!hasBalancedParens(rule)) {
    throw new Error('permission rule scope must not contain parentheses');
  }
  if (rule.includes('\n') || rule.includes('\r')) {
    throw new Error('permission rule scope must be a single line');
  }
  if (rule.length > 300) {
    throw new Error('permission rule scope must be 300 characters or less');
  }
  return rule;
}

function parseCanonicalPermissionRule(
  canonical: string,
): { toolName: string; rule?: string } | null {
  const text = canonical.trim();
  if (
    !text ||
    text.length > 360 ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return null;
  }
  if (text.startsWith('mcp__')) {
    return { toolName: normalizeMcpPattern(text) };
  }
  const scoped = /^([A-Za-z][A-Za-z0-9]*)(?:\((.*)\))?$/.exec(text);
  if (!scoped) return null;
  const toolName = normalizeToolName(scoped[1]);
  const rule = normalizeRuleText(scoped[2]);
  if (scoped[2] !== undefined && !rule) return null;
  return rule ? { toolName, rule } : { toolName };
}

function normalizeMcpPattern(value: string): string {
  const pattern = value.trim();
  if (!/^mcp__[A-Za-z0-9_-]+__(?:[A-Za-z0-9_-]+|\*)$/.test(pattern)) {
    throw new Error(
      'MCP permission rules must look like mcp__server__tool or mcp__server__*',
    );
  }
  return pattern;
}

function hasBalancedParens(value: string): boolean {
  return !value.includes('(') && !value.includes(')');
}

function isBroadScope(value: string): boolean {
  const normalized = value.trim();
  return normalized === '*' || normalized === '**' || normalized === '*.*';
}

function toolMatchValue(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (toolName === 'Bash' && typeof record.command === 'string') {
    return record.command;
  }
  if (
    (toolName === 'Edit' ||
      toolName === 'NotebookEdit' ||
      toolName === 'Write' ||
      toolName === 'Read') &&
    (typeof record.file_path === 'string' || typeof record.path === 'string')
  ) {
    return String(record.file_path ?? record.path);
  }
  if (toolName === 'WebFetch' && typeof record.url === 'string') {
    if (record.url.startsWith('http')) {
      try {
        const hostname = new URL(record.url).hostname;
        return `domain:${hostname}`;
      } catch {
        return record.url;
      }
    }
    return record.url;
  }
  if (toolName === 'Agent' && typeof record.subagent_type === 'string') {
    return record.subagent_type;
  }
  return JSON.stringify(record);
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
  return regex.test(value);
}

function uniqueRules(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const rule = value.trim();
    if (!rule || seen.has(rule)) continue;
    validateCanonicalPermissionRule(rule);
    seen.add(rule);
    out.push(rule);
  }
  return out;
}

function ruleRisk(
  toolName: string,
  rule?: string,
): { level: 'low' | 'medium' | 'high'; reason: string } {
  if (HIGH_RISK_WHOLE_TOOLS.has(toolName) && !rule) {
    return {
      level: 'high',
      reason: `${toolName} without a scope can modify or execute broad host actions.`,
    };
  }
  if (WORKSPACE_MUTATING_TOOLS.has(toolName)) {
    return {
      level: 'medium',
      reason: `${toolName} is limited by the requested scope but still affects the local workspace.`,
    };
  }
  if (toolName.startsWith('mcp__')) {
    return {
      level: 'medium',
      reason: 'MCP tools can call a connected third-party provider.',
    };
  }
  if (!READ_OR_QUERY_TOOLS.has(toolName)) {
    return {
      level: 'medium',
      reason: `${toolName} can affect agent workflow or connected runtime state.`,
    };
  }
  return {
    level: 'low',
    reason: `${toolName} is read-oriented or constrained by normal runtime guards.`,
  };
}

function ruleExamples(toolName: string, rule?: string): string[] {
  if (toolName === 'Bash') {
    return rule
      ? [`Run shell commands matching \`${rule}\`.`]
      : ['Run any Bash command the SDK requests after normal host guards.'];
  }
  if (
    toolName === 'Edit' ||
    toolName === 'NotebookEdit' ||
    toolName === 'Write'
  ) {
    return rule
      ? [`Modify files matching \`${rule}\`.`]
      : [
          `Use ${toolName} wherever the SDK requests it after normal host guards.`,
        ];
  }
  if (toolName === 'WebFetch' && rule?.startsWith('domain:')) {
    return [`Fetch pages from ${rule.slice('domain:'.length)}.`];
  }
  if (toolName.startsWith('mcp__')) {
    return [`Call MCP tool pattern \`${toolName}\`.`];
  }
  if (toolName === 'Agent') {
    return rule
      ? [`Start subagents matching \`${rule}\`.`]
      : ['Start configured subagents after normal host guards.'];
  }
  if (toolName === 'Browser') {
    return rule
      ? [`Use browser automation matching \`${rule}\`.`]
      : ['Use browser automation after normal host guards.'];
  }
  return [`Use \`${toolName}${rule ? `(${rule})` : ''}\`.`];
}

function ruleBoundary(toolName: string, rule?: string): string {
  if (toolName === 'Bash' && rule) {
    return 'Does not allow unrelated shell commands that do not match the pattern.';
  }
  if (
    (toolName === 'Edit' ||
      toolName === 'NotebookEdit' ||
      toolName === 'Write') &&
    rule
  ) {
    return 'Does not allow file changes outside the requested path pattern.';
  }
  if (toolName === 'WebFetch' && rule?.startsWith('domain:')) {
    return 'Does not allow fetching other domains.';
  }
  if (toolName.startsWith('mcp__')) {
    return 'Does not approve other MCP servers or tools.';
  }
  if (rule) {
    return `Does not allow ${toolName} uses outside the requested scope.`;
  }
  return 'Protected settings, secrets, MCP config, and skill-source guards still apply.';
}
