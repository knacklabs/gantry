import type {
  Job,
  JobSetupState,
  JobRunStatus,
  MessageActionAffordance,
} from '../domain/types.js';
import type { SchedulerSendMessage } from './delivery.js';
import { sendJobNotification } from './delivery.js';
import { formatRunStatusMessage } from './status-formatting.js';
import { MEMORY_DREAM_SYSTEM_PROMPT } from './system-jobs.js';
import { formatRunLabel } from '../shared/human-format.js';
import { SETUP_REQUIRED_PAUSE_REASON } from '../application/jobs/job-readiness-service.js';
import { parseAutonomousToolDenial } from '../shared/autonomous-tool-denial.js';
import {
  setupActionLabel,
  setupBlockerLabel,
} from '../shared/job-setup-labels.js';

type TerminalRunStatus = Extract<
  JobRunStatus,
  'completed' | 'failed' | 'timeout' | 'dead_lettered'
>;

export type JobNotificationLifecycleUpdateResult =
  | 'updated'
  | 'unsupported'
  | 'failed';

function recoveryActionAffordances(input: {
  job: Job;
  runId: string;
}): MessageActionAffordance[] {
  return [
    {
      kind: 'scheduler_run_now',
      label: 'Retry now',
      jobId: input.job.id,
      runId: input.runId,
    },
    {
      kind: 'scheduler_show_last_logs',
      label: 'Show last 50 log lines',
      jobId: input.job.id,
      runId: input.runId,
    },
    {
      kind: 'scheduler_pause_job',
      label: 'Pause job',
      jobId: input.job.id,
      runId: input.runId,
    },
    {
      kind: 'scheduler_open',
      label: 'Open in scheduler',
      jobId: input.job.id,
      runId: input.runId,
    },
  ];
}

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
  runShortId?: number | null;
  sendMessage: SchedulerSendMessage;
}): Promise<boolean> {
  if (input.job.silent) return false;
  return sendJobNotification({
    job: input.job,
    text: `Running: ${input.job.name} (${formatRunLabel({
      id: input.runId,
      shortId: input.runShortId,
    })})`,
    phase: 'start',
    runId: input.runId,
    sendMessage: input.sendMessage,
  });
}

export async function notifySchedulerSetupRequired(input: {
  job: Job;
  setupState: JobSetupState;
  sendMessage: SchedulerSendMessage;
}): Promise<boolean> {
  if (input.job.silent) return false;
  if (input.setupState.state === 'ready') return false;
  if (input.setupState.notified_fingerprint === input.setupState.fingerprint) {
    return false;
  }
  const blocker = input.setupState.blockers[0];
  const action = setupActionLabel(blocker);
  const reason = setupBlockerLabel(blocker, input.setupState.state);
  return sendJobNotification({
    job: input.job,
    text: [
      `Setup required: ${input.job.name}`,
      `Blocker: ${reason}`,
      `Action: ${action}`,
      'Next: Resume the job after setup is fixed.',
    ].join('\n'),
    phase: 'summary',
    runId: `setup:${input.setupState.fingerprint}`,
    actionAffordances: [
      {
        kind: 'scheduler_open',
        label: 'Open in scheduler',
        jobId: input.job.id,
      },
    ],
    sendMessage: input.sendMessage,
  });
}

export async function notifySchedulerTerminalRunState(input: {
  job: Job;
  runId: string;
  runShortId?: number | null;
  runStatus: TerminalRunStatus;
  summary: string;
  nextRun: string | null;
  retryCount: number;
  pauseReason: string | null;
  durationMs?: number;
  sendMessage: SchedulerSendMessage;
  updateLifecycleNotification?: (input: {
    job: Job;
    runId: string;
    runStatus: TerminalRunStatus;
    summaryMessage: string;
  }) => Promise<JobNotificationLifecycleUpdateResult>;
}): Promise<boolean> {
  if (input.job.silent) return false;
  if (
    input.pauseReason === SETUP_REQUIRED_PAUSE_REASON &&
    parseAutonomousToolDenial(input.summary)
  ) {
    return false;
  }
  const summaryMessage = formatRunStatusMessage({
    job: input.job,
    runId: input.runId,
    runShortId: input.runShortId,
    runStatus: input.runStatus,
    summary: input.summary,
    nextRun: input.nextRun,
    retryCount: input.retryCount,
    pauseReason: input.pauseReason,
    durationMs: input.durationMs,
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
  const actionAffordances =
    input.runStatus === 'completed'
      ? undefined
      : recoveryActionAffordances({ job: input.job, runId: input.runId });
  return sendJobNotification({
    job: input.job,
    text: summaryMessage,
    phase: 'summary',
    runId: input.runId,
    actionAffordances,
    sendMessage: input.sendMessage,
  });
}
