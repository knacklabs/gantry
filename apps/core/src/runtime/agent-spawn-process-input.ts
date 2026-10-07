import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../infrastructure/logging/logger.js';
import type { AgentOutput, RunnerProcessSpec } from './agent-spawn-types.js';
import { activeRunStopWasRequested } from './group-queue-stop.js';

export function runnerContextPayload(input: RunnerProcessSpec['input']) {
  const { appId, agentId, sessionId, jobId, runId } = input;
  return { appId, agentId, sessionId, jobId, runId };
}

export function formatResumeSessionStatus(sessionId?: string): string {
  return sessionId ? 'present' : 'none';
}

export function bindRunnerInput(
  spec: RunnerProcessSpec,
  runner: ChildProcessWithoutNullStreams,
  stopped: () => boolean,
  onFailure: () => void,
) {
  let closed = false;
  let error: AgentOutput | undefined;
  const fail = () => {
    if (closed || error || stopped() || activeRunStopWasRequested(runner))
      return;
    error = {
      status: 'error',
      result: null,
      error: 'The agent could not receive the request. Please try again.',
    };
    onFailure();
    logger.error(
      {
        group: spec.group.name,
        processName: spec.processName,
        ...runnerContextPayload(spec.input),
      },
      'Agent request delivery failed, stopping',
    );
    runner.kill('SIGKILL');
    runner.stdin.destroy();
  };
  runner.once('close', () => {
    closed = true;
  });
  // A pending write can fail after timeout, abort, requested stop or close.
  // Keep the listener for the stream's lifetime so late errors stay owned.
  runner.stdin.on('error', fail);
  return {
    error: () => error,
    write: () => {
      if (stopped()) return;
      try {
        runner.stdin.write(JSON.stringify(spec.input));
        runner.stdin.end();
      } catch {
        fail();
      }
    },
  };
}
