import {
  countBrowserActivityForRun,
  createJobRunDiagnostics,
} from './execution-diagnostics.js';
import type { SchedulerDependencies } from './types.js';

const POST_RUN_BROWSER_ACTIVITY_TIMEOUT_MS = 5_000;

export async function countBrowserActivityForRunBestEffort(input: {
  deps: SchedulerDependencies;
  jobId: string;
  runId: string;
  diagnostics: ReturnType<typeof createJobRunDiagnostics>;
  log: { warn: (context: Record<string, unknown>, message: string) => void };
}): Promise<number | null> {
  try {
    return await withTimeout(
      countBrowserActivityForRun(input),
      POST_RUN_BROWSER_ACTIVITY_TIMEOUT_MS,
      'Browser activity verification',
    );
  } catch (err) {
    input.log.warn(
      {
        err,
        jobId: input.jobId,
        runId: input.runId,
      },
      'Failed to verify scheduled job browser activity after runner completion',
    );
    return null;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
