import { type ScheduledJobHeartbeatPayload } from './agent-spawn-scheduled-idle.js';
import type { RunnerProcessSpec } from './agent-spawn-types.js';
export type RunnerTimeoutReason = 'timeout' | 'scheduled_job_idle_stall';
export declare function writeRunnerTimeoutLog(input: {
    spec: RunnerProcessSpec;
    logsDir: string;
    duration: number;
    code: number | null;
    hadStreamingOutput: boolean;
    startupLines: string[];
    timeoutReason: RunnerTimeoutReason;
    scheduledJobIdleMs: number;
    lastScheduledJobHeartbeat: ScheduledJobHeartbeatPayload | null;
    timeoutMs: number;
}): {
    logFile: string;
    error: string;
};
