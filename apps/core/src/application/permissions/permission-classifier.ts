import { gantryNativeCanonicalToolName } from './gantry-tool-risk.js';
import {
  PermissionLane,
  type PermissionLane as PermissionLaneValue,
} from '../../domain/permission-lane.js';

export type PermissionClassifierRequestFamily =
  | 'tool'
  | 'admin'
  | 'review'
  | 'promotion';

const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_.-]+$/;

export function isPermissionClassifierEligible(
  canonicalToolName: string,
  requestFamily: PermissionClassifierRequestFamily,
  lane?: PermissionLaneValue,
): boolean {
  if (requestFamily !== 'tool') return false;

  if (
    lane === PermissionLane.InteractiveAuto &&
    (canonicalToolName === 'FileWrite' || canonicalToolName === 'FileEdit')
  ) {
    return true;
  }

  if (canonicalToolName === 'Bash' || canonicalToolName === 'RunCommand') {
    return true;
  }

  // Reviewed-rule / birthright / read-only fast-paths still short-circuit before
  // the classifier tail runs.
  if (MCP_TOOL_NAME.test(canonicalToolName)) return true;

  // Bare canonical gantry tool names (no mcp__gantry__ prefix) are eligible too.
  return gantryNativeCanonicalToolName(canonicalToolName) !== null;
}
