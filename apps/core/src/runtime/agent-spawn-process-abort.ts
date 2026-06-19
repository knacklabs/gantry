import type { ChildProcess } from 'node:child_process';
import type { AgentOutput } from './agent-spawn-types.js';

type WarnLog = (context: Record<string, unknown>, message: string) => void;

const RUN_ABORT_KILL_GRACE_MS = 5_000;

export interface RunnerAbortBinding {
  aborted(): boolean;
  close(): void;
}

export function abortedRunnerOutput(
  runnerLabel: string,
  externalSessionId?: string,
): AgentOutput {
  return {
    status: 'error',
    result: null,
    ...(externalSessionId ? { providerSession: { externalSessionId } } : {}),
    error: `${runnerLabel} stopped because the run was aborted`,
  };
}

export function bindRunnerAbortSignal(input: {
  signal?: AbortSignal;
  runner: ChildProcess;
  runnerLabel: string;
  context: Record<string, unknown>;
  warn: WarnLog;
}): RunnerAbortBinding {
  let runnerClosed = false;
  let runAborted = false;
  let abortKillTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = () => {
    if (runnerClosed || runAborted) return;
    runAborted = true;
    input.warn(input.context, `${input.runnerLabel} run aborted, stopping`);
    const pid = input.runner.pid;
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        input.runner.kill('SIGTERM');
      }
    } else {
      input.runner.kill('SIGTERM');
    }
    abortKillTimer = setTimeout(() => {
      if (!runnerClosed) input.runner.kill('SIGKILL');
    }, RUN_ABORT_KILL_GRACE_MS);
    abortKillTimer.unref?.();
  };

  if (input.signal?.aborted) {
    terminate();
  } else {
    input.signal?.addEventListener('abort', terminate, { once: true });
  }

  return {
    aborted: () => runAborted,
    close: () => {
      runnerClosed = true;
      if (abortKillTimer) clearTimeout(abortKillTimer);
      input.signal?.removeEventListener('abort', terminate);
    },
  };
}
