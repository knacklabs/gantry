import type { AgentRunnerInput } from './types.js';
import { log } from './logging.js';
import { emitJobToolActivity } from './tool-permission-events.js';

export function denyNonPromptableAutonomousRecovery(input: {
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
  recoveryAction: string | undefined;
  recoveryMessage: string;
  toolName: string;
  toolPolicyReason: string;
}): { behavior: 'deny'; message: string; interrupt: false } | undefined {
  if (isPromptableAutonomousRecovery(input.recoveryAction)) return undefined;
  const message = `Permission denied: ${input.recoveryMessage}`;
  log(`Autonomous run denied tool ${input.toolName}: ${message}`);
  emitJobToolActivity(
    input.agentInput,
    input.getNewSessionId,
    'permission_denied',
    input.toolName,
    {
      ok: false,
      terminal: false,
      reason: input.toolPolicyReason,
      ...(input.recoveryAction
        ? { recovery_action: input.recoveryAction }
        : {}),
    },
  );
  return { behavior: 'deny', message, interrupt: false };
}

function isPromptableAutonomousRecovery(
  recoveryAction: string | undefined,
): boolean {
  if (!recoveryAction) return true;
  return (
    recoveryAction.startsWith('request_permission ') ||
    recoveryAction.startsWith('request_mcp_server ')
  );
}
