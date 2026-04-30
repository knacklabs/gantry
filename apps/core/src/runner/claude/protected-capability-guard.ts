interface ProtectedCapabilityPermissionOpts {
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
}

const PROTECTED_MUTATION_TOOLS = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Config',
]);

const PROTECTED_CAPABILITY_PATTERN =
  /(^|[/"'\s])(\.mcp\.json|settings\.json|mcpServers|permissionMode|alwaysAllowedTools|allowedTools|permissions|\.claude\/skills|\.codex\/skills|\.agents\/skills|SKILL\.md)(?=$|[/"'\s:=,}\]])/i;

function stringifyForPolicy(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function denyProtectedCapabilityToolUse(
  toolName: string,
  input: unknown,
  permissionOpts: ProtectedCapabilityPermissionOpts = {},
): string | null {
  if (!PROTECTED_MUTATION_TOOLS.has(toolName)) return null;

  if (toolName === 'Config') {
    return 'Denied by MyClaw protected-capability guard: Config can mutate agent permissions or provider capabilities. Use MyClaw MCP/admin capability flows instead.';
  }

  const haystack = [
    toolName,
    stringifyForPolicy(input),
    permissionOpts.title,
    permissionOpts.displayName,
    permissionOpts.description,
    permissionOpts.decisionReason,
    permissionOpts.blockedPath,
  ]
    .filter(Boolean)
    .join('\n');

  if (!PROTECTED_CAPABILITY_PATTERN.test(haystack)) return null;

  return 'Denied by MyClaw protected-capability guard: agents cannot directly mutate MCP definitions, Claude permission settings, or skill capability files. Use MyClaw MCP/admin capability flows instead.';
}
