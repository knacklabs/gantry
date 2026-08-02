import { gantryNativeCanonicalToolName } from './gantry-tool-risk.js';

export type PermissionClassifierRequestFamily =
  | 'tool'
  | 'admin'
  | 'review'
  | 'promotion';

const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_.-]+$/;

export function isPermissionClassifierEligible(
  canonicalToolName: string,
  requestFamily: PermissionClassifierRequestFamily,
): boolean {
  if (requestFamily !== 'tool') return false;

  if (canonicalToolName === 'Bash' || canonicalToolName === 'RunCommand') {
    return true;
  }

  // Every MCP tool is now eligible, including gantry-native ones: gantry tools
  // get a deterministic default risk rating (gantryToolDefaultRisk) rather than
  // falling through to an unconditional human prompt. Reviewed-rule / birthright
  // / read-only fast-paths still short-circuit BEFORE the classifier tail runs.
  if (MCP_TOOL_NAME.test(canonicalToolName)) return true;

  // Bare canonical gantry tool names (no mcp__gantry__ prefix) are eligible too.
  return gantryNativeCanonicalToolName(canonicalToolName) !== null;
}
