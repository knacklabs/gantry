import { spawn } from 'node:child_process';
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
/**
 * Production npm runner: spawns the binary directly (no shell), captures
 * bounded output, and enforces a timeout. The argv is fixed and lockfile-pinned
 * by the caller; this runner does not interpolate any user input.
 */
export const spawnNpmRunner = {
    run(input) {
        return new Promise((resolve, reject) => {
            const child = spawn(input.argv[0], input.argv.slice(1), {
                cwd: input.cwd,
                env: input.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                child.kill('SIGKILL');
                reject(new Error(`Toolchain command timed out after ${input.timeoutMs}ms: ${input.argv.join(' ')}`));
            }, input.timeoutMs);
            timer.unref?.();
            child.stdout.on('data', (chunk) => {
                if (stdout.length < MAX_CAPTURED_OUTPUT_BYTES)
                    stdout += chunk.toString();
            });
            child.stderr.on('data', (chunk) => {
                if (stderr.length < MAX_CAPTURED_OUTPUT_BYTES)
                    stderr += chunk.toString();
            });
            child.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
            child.on('close', (code) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve({ exitCode: code ?? 0, stdout, stderr });
            });
        });
    },
};
