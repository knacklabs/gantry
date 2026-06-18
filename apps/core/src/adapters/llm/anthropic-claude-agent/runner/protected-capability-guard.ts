import { denyProtectedCapabilityToolUse as denyProtectedCapabilityToolUseCore } from '../../../../runner/tool-gate-core.js';

// Thin SDK-side wrapper over the neutral runner tool-gate core. The decision
// logic and deny copy are provider-neutral and shared with the DeepAgents lane;
// the lane-specific concern here is just the (unused) SDK permission-opts arg
// in the CanUseTool call site.
export function denyProtectedCapabilityToolUse(
  toolName: string,
  input: unknown,
  _permissionOpts?: unknown,
): string | null {
  return denyProtectedCapabilityToolUseCore(toolName, input);
}
