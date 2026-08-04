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
import { denyMemoryBoundaryToolUse } from '../shared/memory-boundary.js';

export type DeclarativeToolRule =
  | {
      tool: string;
      action: 'block';
      reason: string;
      when?: { arg: string; matches: string };
    }
  | {
      tool: string;
      action: 'require_prior';
      prior: string;
      reason: string;
    };

export interface DeclarativeToolRuleDenial {
  decision: 'declarative_tool_rule';
  reason: string;
  error: {
    category: 'permission' | 'validation';
    isRetryable: false;
    message: string;
  };
}

export interface ToolSuccessLedger {
  hasSuccess(toolName: string): boolean;
}

export class RunScopedToolSuccessLedger implements ToolSuccessLedger {
  readonly #successfulTools = new Set<string>();

  recordSuccess(toolName: string): void {
    this.#successfulTools.add(toolName);
  }

  hasSuccess(toolName: string): boolean {
    return this.#successfulTools.has(toolName);
  }
}

export function evaluateDeclarativeToolRules(input: {
  toolName: string;
  toolInput: unknown;
  rules?: readonly DeclarativeToolRule[];
  successLedger?: ToolSuccessLedger;
}): DeclarativeToolRuleDenial | null {
  for (const rule of input.rules ?? []) {
    if (!toolGlobMatches(rule.tool, input.toolName)) continue;
    if (rule.action === 'require_prior') {
      if (input.successLedger?.hasSuccess(rule.prior)) continue;
      return declarativeRuleDenial(
        'permission',
        rule.reason,
        `Required prior tool "${rule.prior}" has not completed successfully earlier in this run.`,
      );
    }
    if (!rule.when) {
      return declarativeRuleDenial('permission', rule.reason);
    }
    if (!isDotPath(rule.when.arg)) {
      return declarativeRuleDenial(
        'validation',
        rule.reason,
        `Invalid when.arg "${rule.when.arg}".`,
      );
    }
    let matcher: RegExp;
    try {
      matcher = new RegExp(rule.when.matches);
    } catch {
      return declarativeRuleDenial(
        'validation',
        rule.reason,
        `Invalid when.matches regex "${rule.when.matches}".`,
      );
    }
    const resolved = readDotPath(input.toolInput, rule.when.arg);
    if (!resolved.found) {
      return declarativeRuleDenial(
        'validation',
        rule.reason,
        `when.arg "${rule.when.arg}" could not be resolved.`,
      );
    }
    if (
      typeof resolved.value !== 'string' &&
      typeof resolved.value !== 'number' &&
      typeof resolved.value !== 'boolean'
    ) {
      return declarativeRuleDenial(
        'validation',
        rule.reason,
        `when.arg "${rule.when.arg}" must resolve to a string, number, or boolean.`,
      );
    }
    if (matcher.test(String(resolved.value))) {
      return declarativeRuleDenial('permission', rule.reason);
    }
  }
  return null;
}

function declarativeRuleDenial(
  category: 'permission' | 'validation',
  reason: string,
  detail?: string,
): DeclarativeToolRuleDenial {
  const message = [`Denied by Gantry tool rule: ${reason}`, detail]
    .filter(Boolean)
    .join(' ');
  return {
    decision: 'declarative_tool_rule',
    reason: message,
    error: { category, isRetryable: false, message },
  };
}

function toolGlobMatches(pattern: string, toolName: string): boolean {
  if (!pattern.includes('*')) return pattern === toolName;
  const regex = new RegExp(
    `^${pattern.split('*').map(escapeRegex).join('.*')}$`,
  );
  return regex.test(toolName);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

function isDotPath(value: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value);
}

function readDotPath(
  input: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  let value = input;
  for (const part of path.split('.')) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !Object.prototype.hasOwnProperty.call(value, part)
    ) {
      return { found: false };
    }
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

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
  // .yolo_mode). The neutral gate enforces the settings-owned denylist before
  // policy evaluation. The lane has no auto-approve surface today, but the
  // backstop exists before one ships.
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
  // Host-inherited auto-approve settings; when present and enabled, the neutral
  // gate enforces the denylist after protected-capability and memory-boundary
  // checks and before policy evaluation.
  yoloMode?: YoloModeSettings;
  toolRules?: readonly DeclarativeToolRule[];
  successLedger?: ToolSuccessLedger;
}

// Runs the ordered authority pre-checks that may hard-deny before any
// policy evaluation or permission prompt. Returns the deny reason (already
// user-facing) or null to continue.
export function evaluateNeutralToolPreChecks(input: NeutralPreCheckInput):
  | {
      decision: 'protected_capability' | 'memory_boundary' | 'yolo_denylist';
      reason: string;
    }
  | DeclarativeToolRuleDenial
  | null {
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
  return evaluateDeclarativeToolRules({
    toolName: input.toolName,
    toolInput: input.toolInput,
    rules: input.toolRules,
    successLedger: input.successLedger,
  });
}

export function evaluateNeutralToolPolicy(input: {
  classifier: ToolExecutionClassifier;
  policy: ToolExecutionPolicyService;
  toolName: string;
  toolInput: unknown;
  context: NeutralToolGateContext;
  allowedToolRules: readonly string[];
  autonomousAllowedToolRules?: readonly string[];
  // Locked-preset / fixed-image agents hide the capability request tools;
  // recovery guidance must not instruct calling them.
  capabilityRequestToolsHidden?: boolean;
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
      capabilityRequestToolsHidden: input.capabilityRequestToolsHidden,
    });
  }
  return input.policy.evaluate({
    request,
    allowedToolRules: input.allowedToolRules,
    capabilityRequestToolsHidden: input.capabilityRequestToolsHidden,
  });
}
