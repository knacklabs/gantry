const BASH_TOOL_NAME = 'Bash';

export const RUN_COMMAND_TOOL_NAME = 'RunCommand';
export const GANTRY_FACADE_EXACT_TOOL_NAMES = [
  'WebSearch',
  'WebRead',
  'FileSearch',
  'FileRead',
  'FileEdit',
  'FileWrite',
  'AgentDelegation',
] as const;
export type GantryFacadeExactToolName =
  (typeof GANTRY_FACADE_EXACT_TOOL_NAMES)[number];

const GANTRY_FACADE_EXACT_TOOL_NAME_SET = new Set<string>(
  GANTRY_FACADE_EXACT_TOOL_NAMES,
);
const GANTRY_DELEGATION_TOOL_NAME_SET = new Set([
  'delegate_task',
  'task_message',
]);

export function canonicalGantryToolRuleName(toolName: string): string {
  const canonicalToolName = toolName.startsWith('mcp__gantry__')
    ? toolName.slice('mcp__gantry__'.length)
    : toolName;
  return GANTRY_DELEGATION_TOOL_NAME_SET.has(canonicalToolName)
    ? 'AgentDelegation'
    : canonicalToolName;
}

const PROVIDER_NATIVE_TOOL_REPLACEMENTS = new Map<string, string>([
  ['WebFetch', 'WebRead'],
  ['Glob', 'FileSearch'],
  ['Grep', 'FileSearch'],
  ['Read', 'FileRead'],
  ['Edit', 'FileEdit'],
  ['MultiEdit', 'FileEdit'],
  ['Write', 'FileWrite'],
  ['Bash', 'RunCommand(<argv pattern>)'],
  ['Agent', 'AgentDelegation'],
  ['AskUserQuestion', 'mcp__gantry__ask_user_question'],
  ['TodoWrite', 'mcp__gantry__todo_update'],
]);

const PROVIDER_NATIVE_EXACT_TOOL_NAMES = new Set([
  'Agent',
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'LS',
  'ListMcpResources',
  'MultiEdit',
  'NotebookEdit',
  'Monitor',
  'PushNotification',
  'Read',
  'ReadMcpResource',
  'RemoteTrigger',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TeamCreate',
  'TeamDelete',
  'ToolSearch',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]);

export const PROVIDER_NATIVE_TOOL_REJECTION_REASON =
  'Provider-native SDK tools are execution-harness projections and cannot be persisted as Gantry tool rules; select a Gantry capability such as Browser, a Gantry file/web tool, a semantic capability, an exact Gantry admin MCP tool, or a scoped RunCommand(...) fallback.';

export interface GantryHarnessToolProjection {
  exactTools: Partial<Record<GantryFacadeExactToolName, readonly string[]>>;
  runCommandToolName?: string;
}

export const DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION: GantryHarnessToolProjection =
  {
    exactTools: {
      WebSearch: ['WebSearch'],
      WebRead: ['WebFetch'],
      FileSearch: ['Glob', 'Grep'],
      FileRead: ['Read'],
      FileEdit: ['Edit', 'MultiEdit'],
      FileWrite: ['Write'],
      AgentDelegation: [],
    },
    runCommandToolName: BASH_TOOL_NAME,
  };

export const GANTRY_FACADE_INPUT_SCHEMAS: Record<
  GantryFacadeExactToolName,
  { format: 'json-schema'; schema: Record<string, unknown> }
> = {
  WebSearch: jsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1 },
      maxResults: { type: 'integer', minimum: 1, maximum: 50 },
    },
  }),
  WebRead: jsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri' },
    },
  }),
  FileSearch: jsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'query'],
    properties: {
      mode: { enum: ['path', 'content'] },
      query: { type: 'string', minLength: 1 },
      include: globFilterSchema(),
      exclude: globFilterSchema(),
      maxResults: { type: 'integer', minimum: 1, maximum: 1000 },
    },
  }),
  FileRead: exactPathSchema('Read one exact safe relative file path.'),
  FileEdit: jsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['path', 'patch'],
    properties: {
      path: {
        type: 'string',
        description: 'Exact safe relative file path. Glob patterns rejected.',
      },
      patch: { type: 'string', minLength: 1 },
    },
  }),
  FileWrite: jsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: {
        type: 'string',
        description: 'Exact safe relative file path. Glob patterns rejected.',
      },
      content: { type: 'string' },
    },
  }),
  AgentDelegation: jsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['task'],
    properties: {
      task: { type: 'string', minLength: 1 },
      context: { type: 'string' },
    },
  }),
};

export function providerNativeToolReplacement(toolName: string): string {
  const replacement = PROVIDER_NATIVE_TOOL_REPLACEMENTS.get(toolName.trim());
  return replacement ? ` Use durable Gantry rule ${replacement} instead.` : '';
}

export function providerNativeToolRejectionReason(toolName: string): string {
  return `${PROVIDER_NATIVE_TOOL_REJECTION_REASON}${providerNativeToolReplacement(toolName)}`;
}

export function isProviderNativeExactToolRule(value: string): boolean {
  const rule = value.trim();
  if (parseReadableScopedToolRule(rule)) return false;
  return PROVIDER_NATIVE_EXACT_TOOL_NAMES.has(rule);
}

export function isGantryFacadeExactToolRule(value: string): boolean {
  return GANTRY_FACADE_EXACT_TOOL_NAME_SET.has(value.trim());
}

export function isGantryFacadeExactToolName(
  value: string,
): value is GantryFacadeExactToolName {
  return GANTRY_FACADE_EXACT_TOOL_NAME_SET.has(value);
}

export function isRunCommandToolRule(value: string): boolean {
  const rule = value.trim();
  const scoped = parseReadableScopedToolRule(rule);
  return scoped
    ? scoped.toolName === RUN_COMMAND_TOOL_NAME
    : rule === RUN_COMMAND_TOOL_NAME;
}

export function publicGantryToolNameForSdkTool(toolName: string): string {
  const normalized = toolName.trim();
  if (normalized === BASH_TOOL_NAME) return RUN_COMMAND_TOOL_NAME;
  return PROVIDER_NATIVE_TOOL_REPLACEMENTS.get(normalized) ?? normalized;
}

export function publicCapabilityAllowedToolRules(
  tools: readonly string[],
): string[] {
  const rules = new Set<string>();
  for (const tool of tools) {
    const publicName = publicGantryToolNameForSdkTool(tool);
    if (publicName === RUN_COMMAND_TOOL_NAME) continue;
    rules.add(publicName);
  }
  return [...rules];
}

export function sdkToolsForGantryFacadeTool(
  toolName: string,
): readonly string[] {
  return projectGantryToolRuleForHarness(
    toolName,
    DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION,
  );
}

export function projectGantryToolRuleForHarness(
  toolRule: string,
  projection: GantryHarnessToolProjection,
): string[] {
  const rule = toolRule.trim();
  const scoped = parseReadableScopedToolRule(rule);
  if (scoped) {
    return scoped.toolName === RUN_COMMAND_TOOL_NAME &&
      projection.runCommandToolName
      ? [projection.runCommandToolName]
      : [];
  }
  if (!isGantryFacadeExactToolName(rule)) return [];
  return [...(projection.exactTools[rule] ?? [])];
}

export function validateGantryFacadeToolInput(
  toolName: GantryFacadeExactToolName,
  input: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: `${toolName} input must be an object.` };
  }
  const record = input as Record<string, unknown>;
  switch (toolName) {
    case 'FileSearch':
      return validateFileSearchFacadeInput(record);
    case 'FileRead':
      return validateFacadePathInput(record, 'FileRead');
    case 'FileEdit': {
      const pathValidation = validateFacadePathInput(record, 'FileEdit');
      if (!pathValidation.ok) return pathValidation;
      return typeof record.patch === 'string' && record.patch.length > 0
        ? { ok: true }
        : { ok: false, reason: 'FileEdit patch must be a non-empty string.' };
    }
    case 'FileWrite': {
      const pathValidation = validateFacadePathInput(record, 'FileWrite');
      if (!pathValidation.ok) return pathValidation;
      return typeof record.content === 'string'
        ? { ok: true }
        : { ok: false, reason: 'FileWrite content must be a string.' };
    }
    case 'WebSearch':
      return typeof record.query === 'string' && record.query.trim()
        ? { ok: true }
        : { ok: false, reason: 'WebSearch query must be a non-empty string.' };
    case 'WebRead':
      return typeof record.url === 'string' && isHttpUrl(record.url)
        ? { ok: true }
        : { ok: false, reason: 'WebRead url must be an http(s) URL.' };
    case 'AgentDelegation':
      return typeof record.task === 'string' && record.task.trim()
        ? { ok: true }
        : {
            ok: false,
            reason: 'AgentDelegation task must be a non-empty string.',
          };
  }
}

function parseReadableScopedToolRule(
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

function jsonSchema(schema: Record<string, unknown>): {
  format: 'json-schema';
  schema: Record<string, unknown>;
} {
  return { format: 'json-schema', schema };
}

function globFilterSchema(): Record<string, unknown> {
  return {
    oneOf: [
      { type: 'string', minLength: 1 },
      {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
      },
    ],
  };
}

function exactPathSchema(description: string): {
  format: 'json-schema';
  schema: Record<string, unknown>;
} {
  return jsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: {
        type: 'string',
        description: `${description} Glob patterns rejected.`,
      },
    },
  });
}

function validateFileSearchFacadeInput(
  record: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const mode = record.mode;
  if (mode !== 'path' && mode !== 'content') {
    return {
      ok: false,
      reason: 'FileSearch mode must be "path" or "content".',
    };
  }
  if (typeof record.query !== 'string' || !record.query.trim()) {
    return {
      ok: false,
      reason: 'FileSearch query must be a non-empty string.',
    };
  }
  if (mode === 'content' && hasGlobSyntax(record.query)) {
    return {
      ok: false,
      reason:
        'FileSearch content queries do not accept glob patterns; use include/exclude filters for globs.',
    };
  }
  for (const key of ['include', 'exclude'] as const) {
    const filterValidation = validateOptionalGlobFilter(record[key], key);
    if (!filterValidation.ok) return filterValidation;
  }
  const maxResults = record.maxResults;
  if (
    maxResults !== undefined &&
    (typeof maxResults !== 'number' ||
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 1000)
  ) {
    return {
      ok: false,
      reason: 'FileSearch maxResults must be an integer from 1 to 1000.',
    };
  }
  return { ok: true };
}

function validateFacadePathInput(
  record: Record<string, unknown>,
  toolName: 'FileRead' | 'FileEdit' | 'FileWrite',
): { ok: true } | { ok: false; reason: string } {
  const path = record.path;
  if (typeof path !== 'string') {
    return { ok: false, reason: `${toolName} path must be a string.` };
  }
  const reason = exactSafeRelativePathRejectionReason(path);
  return reason ? { ok: false, reason } : { ok: true };
}

function validateOptionalGlobFilter(
  value: unknown,
  fieldName: 'include' | 'exclude',
): { ok: true } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  const filters = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(filters) || filters.length === 0) {
    return {
      ok: false,
      reason: `FileSearch ${fieldName} must be a non-empty string or string array.`,
    };
  }
  if (filters.some((item) => typeof item !== 'string' || !item.trim())) {
    return {
      ok: false,
      reason: `FileSearch ${fieldName} entries must be non-empty strings.`,
    };
  }
  return { ok: true };
}

function exactSafeRelativePathRejectionReason(value: string): string | null {
  const path = value.trim();
  if (!path) return 'File path must be non-empty.';
  if (path.length > 4096) return 'File path is too long.';
  if (path.includes('\0')) return 'File path cannot contain NUL bytes.';
  if (path.startsWith('/') || path.startsWith('~')) {
    return 'File path must be relative, not absolute or home-relative.';
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) {
    return 'File path must use safe POSIX-style relative segments.';
  }
  if (hasGlobSyntax(path)) {
    return 'File path must be exact; glob patterns are not allowed.';
  }
  const segments = path.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return 'File path must not contain empty, dot, or dot-dot segments.';
  }
  return null;
}

function hasGlobSyntax(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
