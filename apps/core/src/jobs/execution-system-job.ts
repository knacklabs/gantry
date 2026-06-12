import type { Job } from '../domain/types.js';
import {
  abortReason,
  MEMORY_DREAM_SYSTEM_JOB_FINALIZATION_GRACE_MS,
} from '../shared/memory-dreaming-timeout.js';
import { nowMs } from '../shared/time/datetime.js';
import { handleSystemJob, MEMORY_DREAM_SYSTEM_PROMPT } from './system-jobs.js';

type SystemJobContext = Parameters<typeof handleSystemJob>[1];
type SystemJobLogger = {
  warn: (context: Record<string, unknown>, message: string) => void;
};
const NOOP_LOGGER: SystemJobLogger = { warn: () => undefined };

function systemJobWorkDeadlineAtMs(input: {
  job: Job;
  startedAtMs: number;
  timeoutMs: number;
}): number {
  const finalizationGraceMs =
    input.job.prompt === MEMORY_DREAM_SYSTEM_PROMPT
      ? MEMORY_DREAM_SYSTEM_JOB_FINALIZATION_GRACE_MS
      : 0;
  return input.startedAtMs + Math.max(1, input.timeoutMs - finalizationGraceMs);
}

/**
 * Runs a system job turn and normalizes the outcome to either a displayable
 * result string or an error message.
 */
export async function runSystemJobTurn(input: {
  currentJob: Job;
  context: SystemJobContext;
  startedAtMs: number;
  timeoutMs: number;
  logger?: SystemJobLogger;
}): Promise<{ result: string | null; error: string | null }> {
  try {
    const systemResult: unknown = await runSystemJobWithDeadline(input);
    if (typeof systemResult !== 'string') {
      throw new Error('System job returned a non-displayable result.');
    }
    return { result: systemResult, error: null };
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runSystemJobWithDeadline(input: {
  currentJob: Job;
  context: SystemJobContext;
  startedAtMs: number;
  timeoutMs: number;
  logger?: SystemJobLogger;
}): Promise<unknown> {
  const log = input.logger ?? NOOP_LOGGER;
  const controller = new AbortController();
  const timeoutAtMs = input.startedAtMs + input.timeoutMs;
  const timeoutHandle = setTimeout(
    () => {
      controller.abort(
        new Error(`System job timed out after ${input.timeoutMs}ms`),
      );
    },
    Math.max(1, timeoutAtMs - nowMs()),
  );
  timeoutHandle.unref?.();
  let timedOut = false;
  const work = handleSystemJob(input.currentJob, input.context, {
    signal: controller.signal,
    deadlineAtMs: systemJobWorkDeadlineAtMs({
      job: input.currentJob,
      startedAtMs: input.startedAtMs,
      timeoutMs: input.timeoutMs,
    }),
  });
  const observedWork = work.then(
    (result) => {
      if (timedOut) {
        log.warn(
          { jobId: input.currentJob.id },
          'System job work completed after scheduler deadline',
        );
      }
      return result;
    },
    (error) => {
      if (timedOut) {
        log.warn(
          { err: error, jobId: input.currentJob.id },
          'System job work failed after scheduler deadline',
        );
      }
      throw error;
    },
  );
  let onAbort: (() => void) | undefined;
  const abort = new Promise<unknown>((_, reject) => {
    onAbort = () => {
      timedOut = true;
      reject(abortReason(controller.signal));
    };
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([observedWork, abort]);
  } finally {
    clearTimeout(timeoutHandle);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    if (timedOut) await observePostTimeoutWork(observedWork);
  }
}

async function observePostTimeoutWork(work: Promise<unknown>): Promise<void> {
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      const handle = setImmediate(resolve);
      handle.unref?.();
    }),
  ]);
}
