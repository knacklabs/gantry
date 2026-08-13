import { createHash } from 'node:crypto';

import {
  RUNTIME_EVENT_TYPES,
  isRuntimeEventType,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import type {
  JobToolDenial,
  JobToolDeniedEventPayload,
} from '../domain/events/job-tool-denial.js';
import { parseJobSetupActionValue } from '../domain/events/job-tool-denial.js';
import { jobSetupActionEventPayload } from '../domain/events/job-setup-action.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';
import { formatJobSetupAction } from '../shared/job-setup-labels.js';
import {
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
} from '../shared/agent-engine.js';

export const FORWARDED_RUNNER_EVENT_TYPES = new Set<RuntimeEventType>([
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

export interface JobRunDiagnostics {
  lastHeartbeat?: Record<string, unknown>;
  currentTool?: string;
  lastTool?: string;
  pendingPermissionRequests: number;
  pendingPermissionToolNames: string[];
  totalToolCalls: number;
  browserActivityCount: number;
  transientPermissionApprovals: Array<{
    toolName: string;
    mode: string;
    recoveryAction?: string;
  }>;
  startupDiagnostics: Record<string, unknown>[];
  latestStreamedOutputChars: number;
  totalStreamedOutputChars: number;
  lastActivityAt?: string;
  lastPermissionWait?: {
    toolName: string;
    reason?: string;
    recoveryAction?: string;
  };
  terminalToolDenial?: JobToolDenial;
  // 0126: every terminal denial in arrival order; the scalar above stays the
  // FIRST (primary) denial - later ones are still persisted by the epilogue.
  terminalToolDenials: JobToolDenial[];
}

export function toolDenialEventPayload(
  toolDenial: NonNullable<JobRunDiagnostics['terminalToolDenial']>,
  safeErrorSummary: string | null,
): JobToolDeniedEventPayload {
  return {
    error_summary: safeErrorSummary ? safeErrorSummary.slice(0, 500) : null,
    denied_tool: toolDenial.toolName,
    reason: toolDenial.reason,
    denial_kind: toolDenial.denialKind,
    provenance_lane: toolDenial.provenanceLane,
    provenance_seam: toolDenial.provenanceSeam,
    action: jobSetupActionEventPayload(toolDenial.action),
  };
}

export function jobToolDenialIdempotencyKey(
  runId: string,
  denial: JobToolDenial,
): string {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        runId,
        denial.toolName,
        denial.denialKind,
        denial.provenanceSeam,
      ]),
    )
    .digest('hex');
  return `tool_denied:${runId}:${fingerprint}`;
}

export interface StreamingEventFlusher {
  append(chars: number): void;
  flush(force?: boolean): void;
}

/** Throttled JOB_STREAMING progress events (at most one per second). */
export function createStreamingEventFlusher(input: {
  nowMs: () => number;
  emit: (payload: {
    buffered_chars: number;
    total_chars: number;
  }) => Promise<unknown> | unknown;
}): StreamingEventFlusher {
  let bufferedChars = 0;
  let totalChars = 0;
  let lastEventMs = 0;
  return {
    append(chars: number): void {
      bufferedChars += chars;
      totalChars += chars;
    },
    flush(force = false): void {
      if (bufferedChars <= 0) return;
      const timestampMs = input.nowMs();
      if (!force && timestampMs - lastEventMs < 1000) return;
      void input.emit({
        buffered_chars: bufferedChars,
        total_chars: totalChars,
      });
      bufferedChars = 0;
      lastEventMs = timestampMs;
    },
  };
}

export function createJobRunDiagnostics(): JobRunDiagnostics {
  return {
    pendingPermissionRequests: 0,
    pendingPermissionToolNames: [],
    totalToolCalls: 0,
    browserActivityCount: 0,
    transientPermissionApprovals: [],
    startupDiagnostics: [],
    latestStreamedOutputChars: 0,
    totalStreamedOutputChars: 0,
    terminalToolDenials: [],
  };
}

export function updateDiagnosticsFromRuntimeEvent(
  diagnostics: JobRunDiagnostics,
  eventType: RuntimeEventType,
  payload: Record<string, unknown>,
): void {
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
    diagnostics.pendingPermissionToolNames = stringArrayValue(
      payload.pendingPermissionToolNames,
    );
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
  if (eventType !== RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY) return;
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
  if (
    (phase === 'permission_denied' || phase === 'deny') &&
    tool &&
    payload.terminal === true
  ) {
    const matchingWait =
      diagnostics.lastPermissionWait?.toolName === tool
        ? diagnostics.lastPermissionWait
        : undefined;
    const deniedReason = stringValue(payload.reason);
    const denialKind = stringValue(payload.denial_kind);
    const provenanceLane = stringValue(payload.provenance_lane);
    const provenanceSeam = stringValue(payload.provenance_seam);
    if (
      !isJobToolDenialKind(denialKind) ||
      !isJobToolDenialProvenanceLane(provenanceLane) ||
      !isJobToolDenialProvenanceSeam(provenanceSeam)
    ) {
      return;
    }
    const action = parseJobSetupActionValue(payload.action);
    if (!action) return;
    const typedDenial: JobToolDenial = {
      toolName: tool,
      reason:
        matchingWait?.reason && deniedReason
          ? `${matchingWait.reason} Permission denied: ${deniedReason}`
          : (deniedReason ?? matchingWait?.reason ?? 'Permission denied.'),
      denialKind,
      provenanceLane,
      provenanceSeam,
      action,
    };
    diagnostics.terminalToolDenials.push(typedDenial);
    // First denial wins the primary slot (0126); later ones are recorded
    // by the epilogue but never displace the authoritative selection.
    diagnostics.terminalToolDenial ??= typedDenial;
  }
  const source = stringValue(payload.source);
  // Fail closed on PARTIAL provenance: human_once is transient regardless
  // of the (independently optional) repeatable flag, and an explicit
  // non-repeatable flag is transient even without a source. Deliberately NO
  // fallback for payloads carrying NEITHER field: the runtime always stamps
  // provenance (decision 0107; owner-directed no-legacy policy) — such a
  // shape cannot come from current code, and the incident this fixes was
  // spurious pauses, not missed ones.
  const isHumanOnce =
    source === 'human_once' || payload.repeatableForFutureRuns === false;
  if (
    phase === 'permission_allowed' &&
    tool &&
    mode === 'allow_once' &&
    isHumanOnce
  ) {
    const matchingWait =
      diagnostics.lastPermissionWait?.toolName === tool
        ? diagnostics.lastPermissionWait
        : undefined;
    const recoveryAction =
      stringValue(payload.recovery_action) ?? matchingWait?.recoveryAction;
    diagnostics.transientPermissionApprovals.push({
      toolName: tool,
      mode,
      ...(recoveryAction ? { recoveryAction } : {}),
    });
  }
}

export async function forwardRunnerRuntimeEvents(input: {
  events?: readonly { eventType: unknown; payload?: unknown }[];
  diagnostics: JobRunDiagnostics;
  emitJobEvent: (
    eventType: RuntimeEventType,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}): Promise<void> {
  if (!input.events?.length) return;
  for (const event of input.events) {
    if (
      !isRuntimeEventType(event.eventType) ||
      !FORWARDED_RUNNER_EVENT_TYPES.has(event.eventType)
    ) {
      continue;
    }
    const payload = isRecord(event.payload) ? event.payload : {};
    updateDiagnosticsFromRuntimeEvent(
      input.diagnostics,
      event.eventType,
      payload,
    );
    await input.emitJobEvent(event.eventType, payload);
  }
}

export function runnerRuntimeEventKey(event: {
  eventType: unknown;
  payload?: unknown;
}): string | undefined {
  if (
    !isRuntimeEventType(event.eventType) ||
    !FORWARDED_RUNNER_EVENT_TYPES.has(event.eventType)
  ) {
    return undefined;
  }
  let payload: string;
  try {
    payload =
      JSON.stringify(isRecord(event.payload) ? event.payload : {}) ??
      'undefined';
  } catch {
    payload = String(event.payload);
  }
  return `${event.eventType}\u001f${payload}`;
}

export function filterUnforwardedRunnerRuntimeEvents(
  events: Array<{ eventType: unknown; payload?: unknown }> | undefined,
  forwardedKeys: Set<string>,
): Array<{ eventType: unknown; payload?: unknown }> | undefined {
  return events?.filter((event) => {
    const eventKey = runnerRuntimeEventKey(event);
    return !eventKey || !forwardedKeys.has(eventKey);
  });
}

export function terminalDiagnosticsPayload(
  diagnostics: JobRunDiagnostics,
): Record<string, unknown> {
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

export function formatTerminalDiagnostics(
  diagnostics: JobRunDiagnostics,
): string {
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

export function formatTerminalToolDenial(
  diagnostics: JobRunDiagnostics,
): string | undefined {
  const denial = diagnostics.terminalToolDenial;
  if (!denial) return undefined;
  const parts = [`Permission denied for ${denial.toolName}.`];
  if (denial.reason) parts.push(denial.reason);
  parts.push(`Recovery: ${formatJobSetupAction(denial.action)}`);
  return parts.join(' ');
}

function isJobToolDenialKind(
  value: string | undefined,
): value is JobToolDenial['denialKind'] {
  return (
    value === 'permission_denied' ||
    value === 'rule_denied' ||
    value === 'capability_template_mismatch'
  );
}

function isJobToolDenialProvenanceLane(
  value: string | undefined,
): value is JobToolDenial['provenanceLane'] {
  return (
    value === DEFAULT_AGENT_ENGINE ||
    value === DEEPAGENTS_ENGINE ||
    value === 'host'
  );
}

function isJobToolDenialProvenanceSeam(
  value: string | undefined,
): value is JobToolDenial['provenanceSeam'] {
  return (
    value === 'gate' ||
    value === 'recovery' ||
    value === 'declarative' ||
    value === 'capability_run'
  );
}

export function toolAccessRequirementsIncludeBrowser(
  toolAccessRequirements: readonly string[],
): boolean {
  return toolAccessRequirements.some((tool) =>
    isCanonicalBrowserCapabilityRule(tool),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
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

function startupDiagnosticSummary(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return summarizeStartupDiagnosticRecord(payload, 0);
}

function summarizeStartupDiagnosticRecord(
  source: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const summarized = summarizeStartupDiagnosticValue(key, value, depth);
    if (summarized !== undefined) out[key] = summarized;
  }
  return out;
}

function summarizeStartupDiagnosticValue(
  key: string,
  value: unknown,
  depth: number,
): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && STARTUP_DIAGNOSTIC_STRING_KEYS.has(key)) {
    return value.slice(0, 200);
  }
  if (isRecord(value) && depth < 4) {
    const summarized = summarizeStartupDiagnosticRecord(value, depth + 1);
    return Object.keys(summarized).length > 0 ? summarized : undefined;
  }
  return undefined;
}

function isBrowserToolActivity(payload: Record<string, unknown>): boolean {
  if (payload.ok !== true) return false;
  const phase = stringValue(payload.phase);
  if (
    phase === 'sdk_tool_request' ||
    phase === 'permission_wait' ||
    phase === 'permission_allowed' ||
    phase === 'allow' ||
    phase === 'tool_access_preflight' ||
    phase === 'tool_access_missing'
  ) {
    return false;
  }
  const publicTool = stringValue(payload.public_tool);
  const action = stringValue(payload.action);
  return isBrowserGatewayActivity(publicTool, action);
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function isBrowserGatewayActivity(
  publicTool: string | undefined,
  action: string | undefined,
): boolean {
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
