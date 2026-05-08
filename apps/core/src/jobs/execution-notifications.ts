import type { Job, JobRunStatus } from '../domain/types.js';
import type { SchedulerSendMessage } from './delivery.js';
import { sendJobNotification } from './delivery.js';
import { formatRunStatusMessage } from './status-formatting.js';
import { MEMORY_DREAM_SYSTEM_PROMPT } from './system-jobs.js';

type TerminalRunStatus = Extract<
  JobRunStatus,
  'completed' | 'failed' | 'timeout' | 'dead_lettered'
>;

export type JobNotificationLifecycleUpdateResult =
  | 'updated'
  | 'unsupported'
  | 'failed';

export function logMemoryDreamJobFailure(input: {
  job: Job;
  runId: string;
  error: string | null;
  logger: {
    error(payload: Record<string, unknown>, message: string): void;
  };
}): void {
  if (!input.error || input.job.prompt !== MEMORY_DREAM_SYSTEM_PROMPT) return;
  input.logger.error(
    {
      jobId: input.job.id,
      groupScope: input.job.group_scope,
      runId: input.runId,
      error: input.error,
    },
    'Memory dreaming system job failed',
  );
}

export async function notifySchedulerRunStart(input: {
  job: Job;
  runId: string;
  sendMessage: SchedulerSendMessage;
}): Promise<boolean> {
  if (input.job.silent) return false;
  return sendJobNotification({
    job: input.job,
    text: `Scheduler started: ${input.job.name} (#${input.runId.slice(0, 8)})`,
    phase: 'start',
    runId: input.runId,
    sendMessage: input.sendMessage,
  });
}

export async function notifySchedulerTerminalRunState(input: {
  job: Job;
  runId: string;
  runStatus: TerminalRunStatus;
  summary: string;
  nextRun: string | null;
  retryCount: number;
  pauseReason: string | null;
  sendMessage: SchedulerSendMessage;
  updateLifecycleNotification?: (input: {
    job: Job;
    runId: string;
    runStatus: TerminalRunStatus;
    summaryMessage: string;
  }) => Promise<JobNotificationLifecycleUpdateResult>;
}): Promise<boolean> {
  if (input.job.silent) return false;
  const summaryMessage = formatRunStatusMessage({
    job: input.job,
    runId: input.runId,
    runStatus: input.runStatus,
    summary: input.summary,
    nextRun: input.nextRun,
    retryCount: input.retryCount,
    pauseReason: input.pauseReason,
  });
  const updateResult =
    input.updateLifecycleNotification === undefined
      ? 'unsupported'
      : await input.updateLifecycleNotification({
          job: input.job,
          runId: input.runId,
          runStatus: input.runStatus,
          summaryMessage,
        });
  if (updateResult === 'updated') return true;
  return sendJobNotification({
    job: input.job,
    text: summaryMessage,
    phase: 'summary',
    runId: input.runId,
    sendMessage: input.sendMessage,
  });
}
