import {
  buildAgentToolExecutionRequest,
  evaluateProtectedCapabilityToolUse,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../shared/tool-execution-policy-service.js';
import { denyMemoryBoundaryToolUse } from '../shared/memory-boundary.js';

const SHELL_POLICY_TOOL_NAME = 'Bash';

export function evaluateAsyncCommandStartPolicy(input: {
  command: string;
  conversationId: string;
  threadId?: string | null;
  parentJobId?: string | null;
  allowedToolRules: readonly string[];
  memoryBlock?: string;
  isScheduledJob?: boolean;
  classifier: ToolExecutionClassifier;
  policy: ToolExecutionPolicyService;
}): { ok: true; matchedRule?: string } | { ok: false; message: string } {
  const policyInput = { command: input.command };
  const protectedDenial = evaluateProtectedCapabilityToolUse(
    SHELL_POLICY_TOOL_NAME,
    policyInput,
  );
  if (protectedDenial) {
    return {
      ok: false,
      message: `Denied by Gantry tool execution policy: ${protectedDenial.reason} ${protectedDenial.recoveryAction}`,
    };
  }
  const memoryDenial = denyMemoryBoundaryToolUse(
    SHELL_POLICY_TOOL_NAME,
    policyInput,
    {},
    input.memoryBlock ?? '',
  );
  if (memoryDenial) return { ok: false, message: memoryDenial };

  const request = buildAgentToolExecutionRequest(
    input.classifier,
    SHELL_POLICY_TOOL_NAME,
    policyInput,
    {
      conversationId: input.conversationId,
      threadId: input.threadId ?? undefined,
      jobId: input.parentJobId ?? undefined,
      isScheduledJob: input.isScheduledJob,
    },
  );
  const decision = input.policy.evaluate({
    request,
    ...(input.isScheduledJob
      ? { autonomousAllowedToolRules: input.allowedToolRules }
      : { allowedToolRules: input.allowedToolRules }),
  });
  if (decision.status !== 'allow') {
    return {
      ok: false,
      message:
        'This command is not approved for this agent. Request access or choose an approved capability.',
    };
  }
  return { ok: true, matchedRule: decision.matchedRule };
}
