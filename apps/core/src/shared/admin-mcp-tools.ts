export const ADMIN_MCP_TOOL_NAMES = [
  'settings_desired_state',
  'request_settings_update',
  'guided_action_preview',
  'admin_permission_list',
  'admin_permission_revoke',
  'service_restart',
  'register_agent',
] as const;

export type AdminMcpToolName = (typeof ADMIN_MCP_TOOL_NAMES)[number];

export const ADMIN_MCP_TOOL_FULL_NAMES = ADMIN_MCP_TOOL_NAMES.map(
  (toolName) => `mcp__gantry__${toolName}`,
) as readonly `mcp__gantry__${AdminMcpToolName}`[];

const ADMIN_MCP_TOOL_NAME_SET = new Set<string>(ADMIN_MCP_TOOL_NAMES);
const ADMIN_MCP_TOOL_FULL_NAME_SET = new Set<string>(ADMIN_MCP_TOOL_FULL_NAMES);

export function adminMcpToolFullName(
  toolName: AdminMcpToolName,
): `mcp__gantry__${AdminMcpToolName}` {
  return `mcp__gantry__${toolName}`;
}

export function adminMcpToolIdForFullName(toolFullName: string): string {
  return `tool:${toolFullName}`;
}

export function isAdminMcpToolName(value: string): value is AdminMcpToolName {
  return ADMIN_MCP_TOOL_NAME_SET.has(value);
}

export function isAdminMcpToolFullName(value: string): boolean {
  return ADMIN_MCP_TOOL_FULL_NAME_SET.has(value);
}

export function adminMcpToolNameFromFullName(
  value: string,
): AdminMcpToolName | null {
  if (!isAdminMcpToolFullName(value)) return null;
  const name = value.slice('mcp__gantry__'.length);
  return isAdminMcpToolName(name) ? name : null;
}

export function isGantryMcpWildcardRule(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === 'mcp__gantry__*' ||
    trimmed.startsWith('mcp__gantry__*(') ||
    trimmed.startsWith('mcp__gantry__(')
  );
}
