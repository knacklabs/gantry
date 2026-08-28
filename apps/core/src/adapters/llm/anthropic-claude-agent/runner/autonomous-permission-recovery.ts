import type { AgentRunnerInput } from './types.js';
import { DEFAULT_AGENT_ENGINE } from '../../../../shared/agent-engine.js';
import { autonomousToolAuthorityAddition } from '../../../../shared/tool-execution-policy-service.js';
import { log } from './logging.js';
import { emitToolActivity } from './tool-permission-events.js';
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
  invocationId: string;
}): { behavior: 'deny'; message: string; interrupt: true } | undefined {
  const action = autonomousDenialSetupAction({
    toolName: input.toolName,
    toolInput: input.toolInput,
    capabilityRequestToolsHidden: input.capabilityRequestToolsHidden,
    instruction: input.recoveryAction ?? input.toolPolicyReason,
  });
  if (action.kind === 'approve_grant') return undefined;
  const detail = truthfulAutonomousDenialDetail({
    denialReason: input.toolPolicyReason,
    recoveryMessage: input.recoveryMessage,
  });
  const message = `Tool not on autonomous run allowlist: ${input.toolName}. ${detail}`;
  log(`Autonomous run denied tool ${input.toolName}: ${message}`);
  emitToolActivity(
    input.agentInput,
    input.getNewSessionId,
    'permission_denied',
    input.toolName,
    {
      ok: false,
      terminal: true,
      invocationId: input.invocationId,
      action: jobSetupActionEventPayload(action),
      reason: input.toolPolicyReason,
      denial_kind: 'permission_denied',
      provenance_lane: DEFAULT_AGENT_ENGINE,
      provenance_seam: 'recovery',
    },
  );
  return { behavior: 'deny', message, interrupt: true };
}

export function truthfulAutonomousDenialDetail(input: {
  denialReason: string;
  recoveryMessage: string;
}): string {
  const denialReason = input.denialReason.trim();
  const recoveryMessage = input.recoveryMessage.trim();
  if (!recoveryMessage || /^Allowed by\b/.test(recoveryMessage)) {
    return denialReason;
  }
  if (!denialReason || recoveryMessage.includes(denialReason)) {
    return recoveryMessage;
  }
  return `${denialReason} ${recoveryMessage}`;
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
