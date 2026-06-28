import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { RunnerProcessSpec } from './agent-spawn-types.js';
import type { RunnerStartupTimingPayload } from './agent-spawn-startup-timing.js';

type RunnerTimeoutReason = 'timeout' | 'scheduled_job_idle_stall';

export function publishRunnerProcessStartupDiagnostic(input: {
  spec: RunnerProcessSpec;
  code: number | null;
  signal: NodeJS.Signals | null;
  hadStreamingOutput: boolean;
  timedOut: boolean;
  timeoutReason: RunnerTimeoutReason;
  startupTiming: RunnerStartupTimingPayload;
}): void {
  const publishRuntimeEvent = input.spec.options?.publishRuntimeEvent;
  const agentInput = input.spec.input;
  if (!publishRuntimeEvent || !agentInput.appId) return;

  const event: RuntimeEventPublishInput = {
    appId: agentInput.appId as RuntimeEventPublishInput['appId'],
    ...(agentInput.agentId
      ? { agentId: agentInput.agentId as RuntimeEventPublishInput['agentId'] }
      : {}),
    ...(agentInput.runId
      ? { runId: agentInput.runId as RuntimeEventPublishInput['runId'] }
      : {}),
    ...(agentInput.jobId
      ? { jobId: agentInput.jobId as RuntimeEventPublishInput['jobId'] }
      : {}),
    conversationId:
      agentInput.chatJid as RuntimeEventPublishInput['conversationId'],
    ...(agentInput.threadId
      ? {
          threadId: agentInput.threadId as RuntimeEventPublishInput['threadId'],
        }
      : {}),
    eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
    actor: 'runtime',
    responseMode: 'none',
    payload: {
      provider: 'host',
      diagnostic: 'runner_process_timing',
      sandbox: {
        provider: input.spec.options?.runnerSandboxProvider.id,
        enforcing: input.spec.options?.runnerSandboxProvider.enforcing === true,
      },
      exit: {
        code: input.code,
        signal: input.signal ?? null,
        timedOut: input.timedOut,
        ...(input.timedOut ? { timeoutReason: input.timeoutReason } : {}),
        hadStreamingOutput: input.hadStreamingOutput,
      },
      startupTiming: input.startupTiming,
    },
  };

  try {
    void Promise.resolve(publishRuntimeEvent(event)).catch((err) => {
      logger.warn(
        {
          err,
          appId: agentInput.appId,
          runId: agentInput.runId,
          jobId: agentInput.jobId,
        },
        'Runner process startup diagnostic persistence failed',
      );
    });
  } catch (err) {
    logger.warn(
      {
        err,
        appId: agentInput.appId,
        runId: agentInput.runId,
        jobId: agentInput.jobId,
      },
      'Runner process startup diagnostic persistence failed',
    );
  }
}
