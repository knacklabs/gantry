import type { AgentOutput } from './agent-spawn-types.js';
export interface ScheduledJobHeartbeatPayload {
    lastTool?: string;
    currentTool?: string;
    lastActivityAt?: string;
    lastActivityAgoMs?: number;
    pendingPermissionRequests?: number;
    pendingPermissionToolNames?: string[];
    totalToolCalls?: number;
}
export declare function scheduledJobIdleTimeoutMs(): number;
export declare function readScheduledJobHeartbeat(output: AgentOutput): ScheduledJobHeartbeatPayload | null;
export declare function formatScheduledJobIdleStallError(input: {
    timeoutMs: number;
    heartbeat?: ScheduledJobHeartbeatPayload | null;
    logFile?: string;
}): string;
