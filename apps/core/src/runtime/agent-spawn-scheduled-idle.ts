import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { formatDuration } from '../shared/human-format.js';
import type { AgentOutput } from './agent-spawn-types.js';

const DEFAULT_SCHEDULED_JOB_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_SCHEDULED_JOB_IDLE_TIMEOUT_MS = 60 * 1000;

export interface ScheduledJobHeartbeatPayload {
  lastTool?: string;
  currentTool?: string;
  lastActivityAt?: string;
  lastActivityAgoMs?: number;
  pendingPermissionRequests?: number;
  pendingPermissionToolNames?: string[];
  totalToolCalls?: number;
}

export function scheduledJobIdleTimeoutMs(): number {
  const raw = process.env.GANTRY_SCHEDULED_JOB_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_SCHEDULED_JOB_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCHEDULED_JOB_IDLE_TIMEOUT_MS;
  }
  return Math.max(MIN_SCHEDULED_JOB_IDLE_TIMEOUT_MS, Math.trunc(parsed));
}

export function readScheduledJobHeartbeat(
  output: AgentOutput,
): ScheduledJobHeartbeatPayload | null {
  for (const event of output.runtimeEvents ?? []) {
    if (event.eventType !== RUNTIME_EVENT_TYPES.JOB_HEARTBEAT) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return null;
    const record = payload as Record<string, unknown>;
    return {
      lastTool:
        typeof record.lastTool === 'string' ? record.lastTool : undefined,
      currentTool:
        typeof record.currentTool === 'string' ? record.currentTool : undefined,
      lastActivityAt:
        typeof record.lastActivityAt === 'string'
          ? record.lastActivityAt
          : undefined,
      lastActivityAgoMs:
        typeof record.lastActivityAgoMs === 'number'
          ? record.lastActivityAgoMs
          : undefined,
      pendingPermissionRequests:
        typeof record.pendingPermissionRequests === 'number'
          ? record.pendingPermissionRequests
          : undefined,
      pendingPermissionToolNames: Array.isArray(
        record.pendingPermissionToolNames,
      )
        ? record.pendingPermissionToolNames.filter(
            (toolName): toolName is string => typeof toolName === 'string',
          )
        : undefined,
      totalToolCalls:
        typeof record.totalToolCalls === 'number'
          ? record.totalToolCalls
          : undefined,
    };
  }
  return null;
}

export function formatScheduledJobIdleStallError(input: {
  timeoutMs: number;
  heartbeat?: ScheduledJobHeartbeatPayload | null;
  logFile?: string;
}): string {
  const { timeoutMs, heartbeat, logFile } = input;
  const pendingCount = heartbeat?.pendingPermissionRequests ?? 0;
  const pendingTools = heartbeat?.pendingPermissionToolNames?.length
    ? heartbeat.pendingPermissionToolNames.join(', ')
    : 'none';
  const parts = [
    `Scheduled job made no runner or tool progress for ${formatDuration(timeoutMs)}.`,
    `lastTool=${heartbeat?.lastTool ?? heartbeat?.currentTool ?? 'none'}`,
    `lastActivityAt=${heartbeat?.lastActivityAt ?? 'unknown'}`,
    `pendingPermissions=${pendingCount} (${pendingTools})`,
    `totalToolCalls=${heartbeat?.totalToolCalls ?? 0}`,
  ];
  if (logFile) parts.push(`logFile=${logFile}`);
  return parts.join(' ');
}
