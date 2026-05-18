import { spawn } from 'node:child_process';

export interface ApprovedCommandRunInput {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stderrMaxBytes?: number;
  redactOutput?: (value: string) => string;
}

export function runApprovedSandboxCommand(
  input: ApprovedCommandRunInput,
): Promise<void> {
  const [command, ...args] = input.argv;
  if (!command) throw new Error('Command is empty.');
  const stderrMaxBytes = input.stderrMaxBytes ?? 4000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.resume();
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Command timed out.'));
    }, input.timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-stderrMaxBytes);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const redacted = input.redactOutput
        ? input.redactOutput(stderr.trim())
        : stderr.trim();
      reject(
        new Error(
          `Command failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}${redacted ? `: ${redacted}` : ''}`,
        ),
      );
    });
  });
}
