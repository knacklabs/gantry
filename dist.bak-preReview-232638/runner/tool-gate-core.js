import { buildAgentToolExecutionRequest, evaluateProtectedCapabilityToolUse, } from '../shared/tool-execution-policy-service.js';
import { evaluateYoloModeDenylist, yoloModeDenylistDenyReason, } from '../shared/yolo-mode-policy.js';
import { denyMemoryBoundaryToolUse } from '../shared/memory-boundary.js';
export class RunScopedToolSuccessLedger {
    #successfulTools = new Set();
    recordSuccess(toolName) {
        this.#successfulTools.add(toolName);
    }
    hasSuccess(toolName) {
        return this.#successfulTools.has(toolName);
    }
}
export function evaluateDeclarativeToolRules(input) {
    for (const rule of input.rules ?? []) {
        if (!toolGlobMatches(rule.tool, input.toolName))
            continue;
        if (rule.action === 'require_prior') {
            if (input.successLedger?.hasSuccess(rule.prior))
                continue;
            return declarativeRuleDenial('permission', rule.reason, `Required prior tool "${rule.prior}" has not completed successfully earlier in this run.`);
        }
        if (!rule.when) {
            return declarativeRuleDenial('permission', rule.reason);
        }
        if (!isDotPath(rule.when.arg)) {
            return declarativeRuleDenial('validation', rule.reason, `Invalid when.arg "${rule.when.arg}".`);
        }
        let matcher;
        try {
            matcher = new RegExp(rule.when.matches);
        }
        catch {
            return declarativeRuleDenial('validation', rule.reason, `Invalid when.matches regex "${rule.when.matches}".`);
        }
        const resolved = readDotPath(input.toolInput, rule.when.arg);
        if (!resolved.found) {
            return declarativeRuleDenial('validation', rule.reason, `when.arg "${rule.when.arg}" could not be resolved.`);
        }
        if (typeof resolved.value !== 'string' &&
            typeof resolved.value !== 'number' &&
            typeof resolved.value !== 'boolean') {
            return declarativeRuleDenial('validation', rule.reason, `when.arg "${rule.when.arg}" must resolve to a string, number, or boolean.`);
        }
        if (matcher.test(String(resolved.value))) {
            return declarativeRuleDenial('permission', rule.reason);
        }
    }
    return null;
}
function declarativeRuleDenial(category, reason, detail) {
    const message = [`Denied by Gantry tool rule: ${reason}`, detail]
        .filter(Boolean)
        .join(' ');
    return {
        decision: 'declarative_tool_rule',
        reason: message,
        error: { category, isRetryable: false, message },
    };
}
function toolGlobMatches(pattern, toolName) {
    if (!pattern.includes('*'))
        return pattern === toolName;
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
    return regex.test(toolName);
}
function escapeRegex(value) {
    return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}
function isDotPath(value) {
    return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value);
}
function readDotPath(input, path) {
    let value = input;
    for (const part of path.split('.')) {
        if (typeof value !== 'object' ||
            value === null ||
            !Object.prototype.hasOwnProperty.call(value, part)) {
            return { found: false };
        }
        value = value[part];
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
export const LOCKED_ACCESS_PRESET_DENY_REASON = 'capability not provisioned: this agent runs with a locked access preset and cannot request new tools, skills, MCP servers, or permissions. Provision the capability before the run.';
export function denyProtectedCapabilityToolUse(toolName, input) {
    const decision = evaluateProtectedCapabilityToolUse(toolName, input);
    if (!decision)
        return null;
    return `Denied by Gantry tool execution policy: ${decision.reason} ${decision.recoveryAction}`;
}
// Runs the ordered authority pre-checks that may hard-deny before any
// policy evaluation or permission prompt. Returns the deny reason (already
// user-facing) or null to continue.
export function evaluateNeutralToolPreChecks(input) {
    const protectedDenial = denyProtectedCapabilityToolUse(input.toolName, input.toolInput);
    if (protectedDenial) {
        return { decision: 'protected_capability', reason: protectedDenial };
    }
    const memoryDenial = denyMemoryBoundaryToolUse(input.toolName, input.toolInput, {}, input.memoryBlock, input.isThirdPartyMcpTool === true);
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
export function evaluateNeutralToolPolicy(input) {
    const request = buildAgentToolExecutionRequest(input.classifier, input.toolName, input.toolInput, input.context);
    if (input.context.isScheduledJob) {
        return input.policy.evaluate({
            request,
            autonomousAllowedToolRules: input.autonomousAllowedToolRules ?? input.allowedToolRules,
            capabilityRequestToolsHidden: input.capabilityRequestToolsHidden,
        });
    }
    return input.policy.evaluate({
        request,
        allowedToolRules: input.allowedToolRules,
        capabilityRequestToolsHidden: input.capabilityRequestToolsHidden,
    });
}
