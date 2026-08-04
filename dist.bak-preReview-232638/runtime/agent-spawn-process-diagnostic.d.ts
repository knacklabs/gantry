import type { RunnerProcessSpec } from './agent-spawn-types.js';
import type { RunnerStartupTimingPayload } from './agent-spawn-startup-timing.js';
type RunnerTimeoutReason = 'timeout' | 'scheduled_job_idle_stall';
export declare function publishRunnerProcessStartupDiagnostic(input: {
    spec: RunnerProcessSpec;
    code: number | null;
    signal: NodeJS.Signals | null;
    hadStreamingOutput: boolean;
    timedOut: boolean;
    timeoutReason: RunnerTimeoutReason;
    startupTiming: RunnerStartupTimingPayload;
}): void;
export {};
