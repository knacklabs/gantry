export interface ApprovedCommandRunInput {
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    stdoutMaxBytes?: number;
    stderrMaxBytes?: number;
    redactOutput?: (value: string) => string;
}
export interface ApprovedCommandRunResult {
    stdout: string;
    stderr: string;
}
export declare function runApprovedSandboxCommand(input: ApprovedCommandRunInput): Promise<ApprovedCommandRunResult>;
