import {
  RUNTIME_EVENT_TYPES,
  isRuntimeEventType,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';
import type { SchedulerDependencies } from './types.js';

export const FORWARDED_RUNNER_EVENT_TYPES = new Set<RuntimeEventType>([
  RUNTIME_EVENT_TYPES.JOB_HEARTBEAT,
  RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
  RUNTIME_EVENT_TYPES.TASK_NOTIFICATION,
  RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
  RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED,
  RUNTIME_EVENT_TYPES.PERMISSION_DENIED,
  RUNTIME_EVENT_TYPES.PERMISSION_CANCELLED,
  RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED,
  RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
  RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
  RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
]);

export interface JobRunDiagnostics {
  lastHeartbeat?: Record<string, unknown>;
  currentTool?: string;
  lastTool?: string;
  pendingPermissionRequests: number;
  pendingPermissionToolNames: string[];
  totalToolCalls: number;
  browserActivityCount: number;
  transientPermissionApprovals: Array<{ toolName: string; mode: string }>;
  latestStreamedOutputChars: number;
  totalStreamedOutputChars: number;
  lastActivityAt?: string;
  lastPermissionWait?: {
    toolName: string;
    reason?: string;
    recoveryAction?: string;
  };
  terminalToolDenial?: {
    toolName: string;
    reason?: string;
    recoveryAction?: string;
  };
}

export function createJobRunDiagnostics(): JobRunDiagnostics {
  return {
    pendingPermissionRequests: 0,
    pendingPermissionToolNames: [],
    totalToolCalls: 0,
    browserActivityCount: 0,
    transientPermissionApprovals: [],
    latestStreamedOutputChars: 0,
    totalStreamedOutputChars: 0,
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
  if (phase === 'permission_denied' && tool && payload.terminal !== false) {
    const matchingWait =
      diagnostics.lastPermissionWait?.toolName === tool
        ? diagnostics.lastPermissionWait
        : undefined;
    const deniedReason = stringValue(payload.reason);
    diagnostics.terminalToolDenial = {
      toolName: tool,
      reason:
        matchingWait?.reason && deniedReason
          ? `${matchingWait.reason} Permission denied: ${deniedReason}`
          : (deniedReason ?? matchingWait?.reason),
      recoveryAction:
        stringValue(payload.recovery_action) ?? matchingWait?.recoveryAction,
    };
  }
  if (
    phase === 'permission_allowed' &&
    tool &&
    mode &&
    (mode === 'allow_once' || mode === 'allow_timed_grant')
  ) {
    diagnostics.transientPermissionApprovals.push({ toolName: tool, mode });
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
  if (denial.recoveryAction) parts.push(`Recovery: ${denial.recoveryAction}`);
  return parts.join(' ');
}

export function requiredToolsIncludeBrowser(
  requiredTools: readonly string[],
): boolean {
  return requiredTools.some((tool) => isCanonicalBrowserCapabilityRule(tool));
}

export async function countBrowserActivityForRun(input: {
  deps: SchedulerDependencies;
  jobId: string;
  runId: string;
  diagnostics: JobRunDiagnostics;
}): Promise<number> {
  const events = await input.deps.opsRepository.listRecentJobEvents(200, {
    job_id: input.jobId,
    run_id: input.runId,
    event_type: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
  });
  const persisted = events.filter((event) => {
    if (!event.payload) return false;
    try {
      const parsed = JSON.parse(event.payload) as unknown;
      return isRecord(parsed) && isBrowserToolActivity(parsed);
    } catch {
      return false;
    }
  }).length;
  return Math.max(persisted, input.diagnostics.browserActivityCount);
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

function isBrowserToolActivity(payload: Record<string, unknown>): boolean {
  if (payload.ok !== true) return false;
  const phase = stringValue(payload.phase);
  if (
    phase === 'sdk_tool_request' ||
    phase === 'permission_wait' ||
    phase === 'permission_allowed' ||
    phase === 'allow' ||
    phase === 'required_tool_preflight' ||
    phase === 'required_tool_satisfied'
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
  'handle_dialog',
  'resize',
]);

function isBrowserGatewayActivity(
  publicTool: string | undefined,
  action: string | undefined,
): boolean {
  if (publicTool === 'browser_open') return action === 'navigate';
  if (publicTool === 'browser_inspect') {
    return action ? BROWSER_INSPECT_BACKEND_ACTIONS.has(action) : false;
  }
  if (publicTool === 'browser_act') {
    return action ? BROWSER_ACT_BACKEND_ACTIONS.has(action) : false;
  }
  return false;
}
