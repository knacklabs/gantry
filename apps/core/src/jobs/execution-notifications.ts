import type {
  Job,
  JobSetupState,
  JobRunStatus,
  MessageActionAffordance,
} from '../domain/types.js';
import type { SchedulerSendMessage } from './delivery.js';
import { sendJobNotification } from './delivery.js';
import { formatRunStatusMessage } from './status-formatting.js';
import {
  isMemoryDreamingSystemJob,
  MEMORY_DREAM_SYSTEM_PROMPT,
} from '../shared/system-job-identity.js';
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
  'updated' | 'unsupported' | 'failed';

function recoveryActionAffordances(input: {
  job: Job;
  runId: string;
}): MessageActionAffordance[] {
  return [
    {
      kind: 'scheduler_pause_job',
      label: 'Pause job',
      jobId: input.job.id,
      runId: input.runId,
    },
  ];
}

function runAgainActionAffordances(_input: {
  job: Job;
  runId: string;
}): MessageActionAffordance[] {
  return [];
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
      workspaceKey: input.job.workspace_key,
      runId: input.runId,
      error: input.error,
    },
    'Memory dreaming system job failed',
  );
}

export async function notifySchedulerRunRecovered(input: {
  job: Job;
  runId: string;
  sendMessage: SchedulerSendMessage;
}): Promise<boolean> {
  if (input.job.silent) return false;
  return sendJobNotification({
    job: input.job,
    text: 'Run recovered: previous worker lost its lease; Gantry safely retried this run.',
    phase: 'start',
    runId: `recovered:${input.runId}`,
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
      `**🛠️ Setup needed** · ${input.job.name}`,
      reason,
      `Action: ${action}`,
    ].join('\n'),
    phase: 'summary',
    runId: `setup:${input.setupState.fingerprint}`,
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
  const summaryMessage =
    compactMemoryDreamingTerminalMessage(input) ??
    formatRunStatusMessage({
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
      ? runAgainActionAffordances({ job: input.job, runId: input.runId })
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

function compactMemoryDreamingTerminalMessage(input: {
  job: Job;
  runStatus: TerminalRunStatus;
  summary: string;
}): string | null {
  if (!isMemoryDreamingSystemJob(input.job)) return null;
  if (input.runStatus !== 'completed') return null;
  if (memoryDreamingSummaryAlreadyRunning(input.summary)) {
    return 'Memory job already running.';
  }
  const reviewCount = memoryDreamingReviewCount(input.summary);
  if (reviewCount) {
    return `Memory job needs review: ${reviewCount} memory change${reviewCount === 1 ? '' : 's'} waiting.`;
  }
  const blockedCount = memoryDreamingBlockedCount(input.summary);
  if (blockedCount) {
    return `Memory job needs attention: ${blockedCount} memory change${blockedCount === 1 ? '' : 's'} blocked while creating reviews.`;
  }
  return memoryDreamingSummaryNeedsAttention(input.summary)
    ? null
    : 'Memory job done.';
}

function memoryDreamingSummaryNeedsAttention(summary: string): boolean {
  return /\b(needs attention|failed|deadline exceeded|timed out)\b/i.test(
    summary,
  );
}

function memoryDreamingReviewCount(summary: string): number | null {
  const match =
    summary.match(/\b(\d+)\s+sent to review\b/i) ||
    summary.match(/\b(\d+)\s+(?:pending\s+)?memory reviews?\b/i);
  return positiveIntegerMatch(match);
}

function memoryDreamingBlockedCount(summary: string): number | null {
  const match = summary.match(/\b(\d+)\s+blocked\b/i);
  return positiveIntegerMatch(match);
}

function positiveIntegerMatch(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function memoryDreamingSummaryAlreadyRunning(summary: string): boolean {
  if (/\balready running\b/i.test(summary)) return true;
  try {
    const parsed = JSON.parse(summary) as unknown;
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { deduped?: unknown }).deduped === true
    );
  } catch {
    return false;
  }
}
