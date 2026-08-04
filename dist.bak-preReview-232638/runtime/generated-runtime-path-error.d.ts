import type { AgentOutput } from './agent-spawn-types.js';
export declare function formatGeneratedRuntimePathPermissionError(input: {
    runnerLabel: string;
    errorText: string;
}): string | null;
export declare function isGeneratedRuntimePathPermissionFailure(errorText: string): boolean;
export declare function formatRunnerProcessExitError(input: {
    runnerLabel: string;
    code: number | null;
    stdout: string;
    stderr: string;
    structuredError: AgentOutput | null;
    newSessionId?: string;
    fallbackStderr: string;
}): AgentOutput;
