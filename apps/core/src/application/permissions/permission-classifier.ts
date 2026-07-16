export type PermissionClassifierRequestFamily =
  | 'tool'
  | 'admin'
  | 'review'
  | 'promotion';

const THIRD_PARTY_MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_.-]+$/;

export function isPermissionClassifierEligible(
  canonicalToolName: string,
  requestFamily: PermissionClassifierRequestFamily,
): boolean {
  if (requestFamily !== 'tool') return false;

  if (canonicalToolName === 'Bash' || canonicalToolName === 'RunCommand') {
    return true;
  }

  const match = THIRD_PARTY_MCP_TOOL_NAME.exec(canonicalToolName);
  return Boolean(match && match[1] !== 'gantry');
}
