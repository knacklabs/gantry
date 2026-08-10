import type { AgentRunnerInput } from './types.js';
import { isGrantableAutonomousToolRecovery } from '../../../../shared/autonomous-tool-denial.js';
import { log } from './logging.js';
import { emitJobToolActivity } from './tool-permission-events.js';

export function denyNonPromptableAutonomousRecovery(input: {
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
  recoveryAction: string | undefined;
  recoveryMessage: string;
  toolName: string;
  toolPolicyReason: string;
}): { behavior: 'deny'; message: string; interrupt: true } | undefined {
  if (isGrantableAutonomousToolRecovery(input.recoveryAction)) return undefined;
  const message = `Tool not on autonomous run allowlist: ${input.toolName}. ${input.recoveryMessage}`;
  log(`Autonomous run denied tool ${input.toolName}: ${message}`);
  emitJobToolActivity(
    input.agentInput,
    input.getNewSessionId,
    'permission_denied',
    input.toolName,
    {
      ok: false,
      terminal: true,
      grantable: false,
      reason: input.toolPolicyReason,
      ...(input.recoveryAction
        ? { recovery_action: input.recoveryAction }
        : {}),
    },
  );
  return { behavior: 'deny', message, interrupt: true };
}
