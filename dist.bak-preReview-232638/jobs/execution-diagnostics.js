import { RUNTIME_EVENT_TYPES, isRuntimeEventType, } from '../domain/events/runtime-event-types.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';
export const FORWARDED_RUNNER_EVENT_TYPES = new Set([
    RUNTIME_EVENT_TYPES.JOB_HEARTBEAT,
    RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
    RUNTIME_EVENT_TYPES.TASK_STARTED,
    RUNTIME_EVENT_TYPES.TASK_PROGRESS,
    RUNTIME_EVENT_TYPES.TASK_UPDATED,
    RUNTIME_EVENT_TYPES.TASK_NOTIFICATION,
    RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
    RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED,
    RUNTIME_EVENT_TYPES.PERMISSION_DENIED,
    RUNTIME_EVENT_TYPES.PERMISSION_CANCELLED,
    RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED,
    RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
    RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
    RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
    RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
]);
export function toolDenialEventPayload(toolDenial, safeErrorSummary) {
    return {
        error_summary: safeErrorSummary ? safeErrorSummary.slice(0, 500) : null,
        denied_tool: toolDenial.toolName,
        recovery_action: toolDenial.recoveryAction ?? null,
        recovery_kind: toolDenial.recoveryAction?.startsWith('request_access')
            ? 'persistent_capability'
            : 'job_policy',
    };
}
/** Throttled JOB_STREAMING progress events (at most one per second). */
export function createStreamingEventFlusher(input) {
    let bufferedChars = 0;
    let totalChars = 0;
    let lastEventMs = 0;
    return {
        append(chars) {
            bufferedChars += chars;
            totalChars += chars;
        },
        flush(force = false) {
            if (bufferedChars <= 0)
                return;
            const timestampMs = input.nowMs();
            if (!force && timestampMs - lastEventMs < 1000)
                return;
            void input.emit({
                buffered_chars: bufferedChars,
                total_chars: totalChars,
            });
            bufferedChars = 0;
            lastEventMs = timestampMs;
        },
    };
}
export function createJobRunDiagnostics() {
    return {
        pendingPermissionRequests: 0,
        pendingPermissionToolNames: [],
        totalToolCalls: 0,
        browserActivityCount: 0,
        transientPermissionApprovals: [],
        startupDiagnostics: [],
        latestStreamedOutputChars: 0,
        totalStreamedOutputChars: 0,
    };
}
export function updateDiagnosticsFromRuntimeEvent(diagnostics, eventType, payload) {
    if (eventType === RUNTIME_EVENT_TYPES.JOB_HEARTBEAT) {
        diagnostics.lastHeartbeat = payload;
        diagnostics.currentTool = stringValue(payload.currentTool);
        diagnostics.lastTool =
            stringValue(payload.lastTool) ??
                diagnostics.currentTool ??
                diagnostics.lastTool;
        diagnostics.pendingPermissionRequests =
            numberValue(payload.pendingPermissionRequests) ??
                diagnostics.pendingPermissionRequests;
        diagnostics.pendingPermissionToolNames = stringArrayValue(payload.pendingPermissionToolNames);
        diagnostics.totalToolCalls =
            numberValue(payload.totalToolCalls) ?? diagnostics.totalToolCalls;
        diagnostics.lastActivityAt =
            stringValue(payload.lastActivityAt) ?? diagnostics.lastActivityAt;
        return;
    }
    if (eventType === RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC) {
        diagnostics.startupDiagnostics.push(startupDiagnosticSummary(payload));
        return;
    }
    if (eventType !== RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY)
        return;
    const tool = stringValue(payload.tool);
    if (tool) {
        diagnostics.currentTool = tool;
        diagnostics.lastTool = tool;
    }
    if (isBrowserToolActivity(payload)) {
        diagnostics.browserActivityCount += 1;
    }
    const mode = stringValue(payload.mode);
    const phase = stringValue(payload.phase);
    if (phase === 'permission_wait' && tool) {
        diagnostics.lastPermissionWait = {
            toolName: tool,
            reason: stringValue(payload.reason),
            recoveryAction: stringValue(payload.recovery_action),
        };
    }
    if (phase === 'permission_denied' && tool && payload.terminal !== false) {
        const matchingWait = diagnostics.lastPermissionWait?.toolName === tool
            ? diagnostics.lastPermissionWait
            : undefined;
        const deniedReason = stringValue(payload.reason);
        diagnostics.terminalToolDenial = {
            toolName: tool,
            reason: matchingWait?.reason && deniedReason
                ? `${matchingWait.reason} Permission denied: ${deniedReason}`
                : (deniedReason ?? matchingWait?.reason),
            recoveryAction: stringValue(payload.recovery_action) ?? matchingWait?.recoveryAction,
        };
    }
    if (phase === 'permission_allowed' && tool && mode === 'allow_once') {
        const matchingWait = diagnostics.lastPermissionWait?.toolName === tool
            ? diagnostics.lastPermissionWait
            : undefined;
        const recoveryAction = stringValue(payload.recovery_action) ?? matchingWait?.recoveryAction;
        diagnostics.transientPermissionApprovals.push({
            toolName: tool,
            mode,
            ...(recoveryAction ? { recoveryAction } : {}),
        });
    }
}
export async function forwardRunnerRuntimeEvents(input) {
    if (!input.events?.length)
        return;
    for (const event of input.events) {
        if (!isRuntimeEventType(event.eventType) ||
            !FORWARDED_RUNNER_EVENT_TYPES.has(event.eventType)) {
            continue;
        }
        const payload = isRecord(event.payload) ? event.payload : {};
        updateDiagnosticsFromRuntimeEvent(input.diagnostics, event.eventType, payload);
        await input.emitJobEvent(event.eventType, payload);
    }
}
export function runnerRuntimeEventKey(event) {
    if (!isRuntimeEventType(event.eventType) ||
        !FORWARDED_RUNNER_EVENT_TYPES.has(event.eventType)) {
        return undefined;
    }
    let payload;
    try {
        payload =
            JSON.stringify(isRecord(event.payload) ? event.payload : {}) ??
                'undefined';
    }
    catch {
        payload = String(event.payload);
    }
    return `${event.eventType}\u001f${payload}`;
}
export function filterUnforwardedRunnerRuntimeEvents(events, forwardedKeys) {
    return events?.filter((event) => {
        const eventKey = runnerRuntimeEventKey(event);
        return !eventKey || !forwardedKeys.has(eventKey);
    });
}
export function terminalDiagnosticsPayload(diagnostics) {
    return {
        last_heartbeat: diagnostics.lastHeartbeat ?? null,
        last_tool: diagnostics.lastTool ?? diagnostics.currentTool ?? null,
        current_tool: diagnostics.currentTool ?? null,
        pending_permission_count: diagnostics.pendingPermissionRequests,
        pending_permission_tools: diagnostics.pendingPermissionToolNames,
        transient_permission_approvals: diagnostics.transientPermissionApprovals,
        startup_diagnostics: diagnostics.startupDiagnostics,
        total_tool_calls: diagnostics.totalToolCalls,
        browser_activity_count: diagnostics.browserActivityCount,
        latest_streamed_output_chars: diagnostics.latestStreamedOutputChars,
        total_streamed_output_chars: diagnostics.totalStreamedOutputChars,
        last_activity_at: diagnostics.lastActivityAt ?? null,
        terminal_tool_denial: diagnostics.terminalToolDenial ?? null,
    };
}
export function formatTerminalDiagnostics(diagnostics) {
    const pendingTools = diagnostics.pendingPermissionToolNames.length
        ? diagnostics.pendingPermissionToolNames.join(', ')
        : 'none';
    return [
        `lastTool=${diagnostics.lastTool ?? diagnostics.currentTool ?? 'none'}`,
        `pendingPermissions=${diagnostics.pendingPermissionRequests} (${pendingTools})`,
        diagnostics.startupDiagnostics.length
            ? `startupDiagnostics=${diagnostics.startupDiagnostics.length}`
            : undefined,
        `totalToolCalls=${diagnostics.totalToolCalls}`,
        `browserActivity=${diagnostics.browserActivityCount}`,
        `latestStreamedOutputChars=${diagnostics.latestStreamedOutputChars}`,
        diagnostics.terminalToolDenial
            ? `terminalToolDenial=${diagnostics.terminalToolDenial.toolName}`
            : undefined,
    ]
        .filter(Boolean)
        .join('; ');
}
export function formatTerminalToolDenial(diagnostics) {
    const denial = diagnostics.terminalToolDenial;
    if (!denial)
        return undefined;
    const parts = [`Permission denied for ${denial.toolName}.`];
    if (denial.reason)
        parts.push(denial.reason);
    if (denial.recoveryAction)
        parts.push(`Recovery: ${denial.recoveryAction}`);
    return parts.join(' ');
}
export function toolAccessRequirementsIncludeBrowser(toolAccessRequirements) {
    return toolAccessRequirements.some((tool) => isCanonicalBrowserCapabilityRule(tool));
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}
function stringArrayValue(value) {
    return Array.isArray(value)
        ? value.filter((entry) => typeof entry === 'string')
        : [];
}
const STARTUP_DIAGNOSTIC_STRING_KEYS = new Set([
    'provider',
    'diagnostic',
    'agentEngine',
    'executionProviderId',
    'execution_provider_id',
    'modelProvider',
    'modelId',
    'endpointFamily',
    'enableToolSearch',
    'reason',
    'anthropicBaseUrlKind',
    'cacheMode',
]);
function startupDiagnosticSummary(payload) {
    return summarizeStartupDiagnosticRecord(payload, 0);
}
function summarizeStartupDiagnosticRecord(source, depth) {
    const out = {};
    for (const [key, value] of Object.entries(source)) {
        const summarized = summarizeStartupDiagnosticValue(key, value, depth);
        if (summarized !== undefined)
            out[key] = summarized;
    }
    return out;
}
function summarizeStartupDiagnosticValue(key, value, depth) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string' && STARTUP_DIAGNOSTIC_STRING_KEYS.has(key)) {
        return value.slice(0, 200);
    }
    if (isRecord(value) && depth < 4) {
        const summarized = summarizeStartupDiagnosticRecord(value, depth + 1);
        return Object.keys(summarized).length > 0 ? summarized : undefined;
    }
    return undefined;
}
function isBrowserToolActivity(payload) {
    if (payload.ok !== true)
        return false;
    const phase = stringValue(payload.phase);
    if (phase === 'sdk_tool_request' ||
        phase === 'permission_wait' ||
        phase === 'permission_allowed' ||
        phase === 'allow' ||
        phase === 'tool_access_preflight' ||
        phase === 'tool_access_missing') {
        return false;
    }
    const publicTool = stringValue(payload.public_tool);
    const action = stringValue(payload.action);
    return isBrowserGatewayActivity(publicTool, action);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const BROWSER_INSPECT_BACKEND_ACTIONS = new Set([
    'tabs',
    'snapshot',
    'screenshot',
    'console_messages',
    'network_requests',
]);
const BROWSER_ACT_BACKEND_ACTIONS = new Set([
    'navigate',
    'back',
    'tabs',
    'click',
    'type',
    'wait_for',
    'screenshot',
    'evaluate',
    'press_key',
    'hover',
    'drag',
    'drop',
    'select_option',
    'fill_form',
    'file_upload',
    'file_attach',
    'handle_dialog',
    'resize',
]);
function isBrowserGatewayActivity(publicTool, action) {
    if (publicTool === 'browser_open')
        return action === 'open' || action === 'navigate';
    if (publicTool === 'browser_inspect') {
        return action ? BROWSER_INSPECT_BACKEND_ACTIONS.has(action) : false;
    }
    if (publicTool === 'browser_act') {
        return action ? BROWSER_ACT_BACKEND_ACTIONS.has(action) : false;
    }
    return false;
}
