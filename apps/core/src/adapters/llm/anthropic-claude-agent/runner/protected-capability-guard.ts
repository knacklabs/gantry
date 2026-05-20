import { evaluateProtectedCapabilityToolUse } from '../../../../shared/tool-execution-policy-service.js';

export function denyProtectedCapabilityToolUse(
  toolName: string,
  input: unknown,
  _permissionOpts?: unknown,
): string | null {
  const decision = evaluateProtectedCapabilityToolUse(toolName, input);
  if (!decision) return null;
  return `Denied by Gantry tool execution policy: ${decision.reason} ${decision.recoveryAction}`;
}
