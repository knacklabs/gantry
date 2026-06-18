import {
  buildAgentToolExecutionRequest,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
  evaluateProtectedCapabilityToolUse,
  type ToolPolicyDecision,
} from '../shared/tool-execution-policy-service.js';
import {
  evaluateYoloModeDenylist,
  yoloModeDenylistDenyReason,
  type YoloModeSettings,
} from '../shared/yolo-mode-policy.js';
import { denyMemoryBoundaryToolUse } from './memory-boundary.js';

// Provider-neutral runner-side tool gate decision core. Holds the order-sensitive
// authority checks that every execution adapter shares:
//   1. protected-capability denial (settings/MCP/skill/provider config writes),
//   2. durable-memory-boundary denial (suppressed instruction-like memory +
//      high-risk command/secret/policy pattern),
//   3. locked-preset denial (agent runs with a provisioned-only access preset),
//   4. tool-execution policy evaluation (selected-capability / autonomous rules).
//
// The functions return provider-neutral verdicts (string deny reasons or a
// ToolPolicyDecision); each lane wraps them in its own provider-typed callback
// shape (an SDK permission callback, or LangChain DynamicTool wrappers). No
// provider SDK types are imported here — keep it that way so this stays reusable.

export const LOCKED_ACCESS_PRESET_DENY_REASON =
  'capability not provisioned: this agent runs with a locked access preset and cannot request new tools, skills, MCP servers, or permissions. Provision the capability before the run.';

export function denyProtectedCapabilityToolUse(
  toolName: string,
  input: unknown,
): string | null {
  const decision = evaluateProtectedCapabilityToolUse(toolName, input);
  if (!decision) return null;
  return `Denied by Gantry tool execution policy: ${decision.reason} ${decision.recoveryAction}`;
}

export interface NeutralToolGateContext {
  isScheduledJob?: boolean;
  jobId?: string;
  threadId?: string;
  conversationId: string;
  // Auto-approve (yolo) settings inherited from the host (settings.permissions
  // .yolo_mode). Threaded so the neutral gate carries the same denylist backstop
  // the SDK gate applies on its timed-grant/always-allow paths. The lane has no
  // auto-approve surface today, but the denylist must exist before one ships.
  yoloMode?: YoloModeSettings;
}

export interface NeutralPreCheckInput {
  toolName: string;
  toolInput: unknown;
  memoryBlock: string;
  // True when the tool came from a configured (third-party) MCP server. These
  // tools reach the gate with bare names (no `mcp__` prefix), so the
  // memory-boundary guard needs this signal to scan them as mcp-equivalent.
  isThirdPartyMcpTool?: boolean;
  // Host-inherited auto-approve settings; when present and enabled, a denylist
  // match is a hard deny in the same ordered position the SDK gate checks it
  // (after protected-capability and memory-boundary, before policy eval /
  // permission prompt).
  yoloMode?: YoloModeSettings;
}

// Runs the ordered authority pre-checks that may hard-deny before any
// policy evaluation or permission prompt. Returns the deny reason (already
// user-facing) or null to continue.
export function evaluateNeutralToolPreChecks(input: NeutralPreCheckInput): {
  decision: 'protected_capability' | 'memory_boundary' | 'yolo_denylist';
  reason: string;
} | null {
  const protectedDenial = denyProtectedCapabilityToolUse(
    input.toolName,
    input.toolInput,
  );
  if (protectedDenial) {
    return { decision: 'protected_capability', reason: protectedDenial };
  }
  const memoryDenial = denyMemoryBoundaryToolUse(
    input.toolName,
    input.toolInput,
    {},
    input.memoryBlock,
    input.isThirdPartyMcpTool === true,
  );
  if (memoryDenial) {
    return { decision: 'memory_boundary', reason: memoryDenial };
  }
  const yoloMatch = evaluateYoloModeDenylist({
    settings: input.yoloMode,
    toolName: input.toolName,
    toolInput: input.toolInput,
  });
  if (yoloMatch) {
    return {
      decision: 'yolo_denylist',
      reason: yoloModeDenylistDenyReason(yoloMatch),
    };
  }
  return null;
}

export function evaluateNeutralToolPolicy(input: {
  classifier: ToolExecutionClassifier;
  policy: ToolExecutionPolicyService;
  toolName: string;
  toolInput: unknown;
  context: NeutralToolGateContext;
  allowedToolRules: readonly string[];
  autonomousAllowedToolRules?: readonly string[];
}): ToolPolicyDecision {
  const request = buildAgentToolExecutionRequest(
    input.classifier,
    input.toolName,
    input.toolInput,
    input.context,
  );
  if (input.context.isScheduledJob) {
    return input.policy.evaluate({
      request,
      autonomousAllowedToolRules:
        input.autonomousAllowedToolRules ?? input.allowedToolRules,
    });
  }
  return input.policy.evaluate({
    request,
    allowedToolRules: input.allowedToolRules,
  });
}
