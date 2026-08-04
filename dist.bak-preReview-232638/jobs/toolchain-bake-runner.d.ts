/**
 * Result of one `npm` invocation inside a bake. `stdout`/`stderr` are captured
 * for failure diagnostics; they are never surfaced raw to a user (the bake
 * sends a concise failure notice instead).
 */
export interface ToolchainCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
/**
 * Injectable command runner for the bake. Unit tests inject a fake so they
 * never touch the real npm registry; production injects {@link spawnNpmRunner}.
 */
export interface ToolchainCommandRunner {
    run(input: {
        argv: string[];
        cwd: string;
        env: NodeJS.ProcessEnv;
        timeoutMs: number;
    }): Promise<ToolchainCommandResult>;
}
/**
 * Production npm runner: spawns the binary directly (no shell), captures
 * bounded output, and enforces a timeout. The argv is fixed and lockfile-pinned
 * by the caller; this runner does not interpolate any user input.
 */
export declare const spawnNpmRunner: ToolchainCommandRunner;
