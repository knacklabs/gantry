import type { ChildProcess } from 'node:child_process';
import type { AgentOutput } from './agent-spawn-types.js';
type WarnLog = (context: Record<string, unknown>, message: string) => void;
export interface RunnerAbortBinding {
    aborted(): boolean;
    close(): void;
}
export declare function abortedRunnerOutput(runnerLabel: string, externalSessionId?: string): AgentOutput;
export declare function bindRunnerAbortSignal(input: {
    signal?: AbortSignal;
    runner: ChildProcess;
    runnerLabel: string;
    context: Record<string, unknown>;
    warn: WarnLog;
}): RunnerAbortBinding;
export {};
