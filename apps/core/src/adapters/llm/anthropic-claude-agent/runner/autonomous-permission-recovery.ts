import type { AgentRunnerInput } from './types.js';
import { DEFAULT_AGENT_ENGINE } from '../../../../shared/agent-engine.js';
import { autonomousToolAuthorityAddition } from '../../../../shared/tool-execution-policy-service.js';
import { log } from './logging.js';
import { emitJobToolActivity } from './tool-permission-events.js';
import {
  approveGrantSetupAction,
  instructionSetupAction,
} from '../../../../shared/job-setup-action.js';
import { jobSetupActionEventPayload } from '../../../../domain/events/job-setup-action.js';

export function denyNonPromptableAutonomousRecovery(input: {
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
  recoveryAction: string | undefined;
  toolInput: unknown;
  capabilityRequestToolsHidden: boolean;
  recoveryMessage: string;
  toolName: string;
  toolPolicyReason: string;
}): { behavior: 'deny'; message: string; interrupt: true } | undefined {
  const action = autonomousDenialSetupAction({
    toolName: input.toolName,
    toolInput: input.toolInput,
    capabilityRequestToolsHidden: input.capabilityRequestToolsHidden,
    instruction: input.recoveryAction ?? input.toolPolicyReason,
  });
  if (action.kind === 'approve_grant') return undefined;
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
      action: jobSetupActionEventPayload(action),
      reason: input.toolPolicyReason,
      denial_kind: 'permission_denied',
      provenance_lane: DEFAULT_AGENT_ENGINE,
      provenance_seam: 'recovery',
    },
  );
  return { behavior: 'deny', message, interrupt: true };
}

export function autonomousDenialSetupAction(input: {
  toolName: string;
  toolInput: unknown;
  capabilityRequestToolsHidden: boolean;
  instruction: string;
}) {
  const grant = autonomousToolAuthorityAddition(input);
  return grant
    ? approveGrantSetupAction(grant)
    : instructionSetupAction(input.instruction);
}
