import type {
  Job,
  JobSetupState,
  JobRunStatus,
  MessageActionAffordance,
} from '../domain/types.js';
import type { SchedulerSendMessage } from './delivery.js';
import { sendJobNotification } from './delivery.js';
import type { MemoryReviewCreatedNotification } from './memory-dreaming-job-outcome.js';
import {
  reviewMessageFallbackText,
  type ReviewMessageView,
} from '../memory/review-message-view.js';
import { formatRunStatusMessage } from './status-formatting.js';
import type { JobRunDiagnostics } from './execution-diagnostics.js';
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
import { humanizeTechnicalIdentifier } from '../shared/user-visible-messages.js';

type TerminalRunStatus = Extract<
  JobRunStatus,
  'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered'
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
  setupNotified?: boolean;
  diagnostics?: JobRunDiagnostics;
  sendMessage: SchedulerSendMessage;
  memoryReviewNotification?: MemoryReviewCreatedNotification;
  updateLifecycleNotification?: (input: {
    job: Job;
    runId: string;
    runStatus: TerminalRunStatus;
    summaryMessage: string;
  }) => Promise<JobNotificationLifecycleUpdateResult>;
}): Promise<boolean> {
  if (input.job.silent) return false;
  // Suppress only when a setup card was actually DELIVERED and the run did
  // not complete: a completed-but-paused run whose setup card was skipped
  // must still get its completed-with-limits card, or the pause is silent.
  // The setup card subsumes the terminal card only when it was DELIVERED
  // and the semantic gate holds: the pause is the setup requirement and the
  // summary parses as the autonomous denial — the denial IS the outcome.
  const suppressTerminalCard =
    input.runStatus !== 'completed' &&
    input.setupNotified === true &&
    input.pauseReason === SETUP_REQUIRED_PAUSE_REASON &&
    parseAutonomousToolDenial(input.summary) !== null;
  if (suppressTerminalCard) {
    // An existing lifecycle/progress message must not stay frozen at
    // "running" next to the setup card — retire it with the terminal
    // summary. If the updater cannot edit in place, fall through to the
    // normal send path so the outcome is never lost.
    const retired = await input.updateLifecycleNotification?.({
      job: input.job,
      runId: input.runId,
      runStatus: input.runStatus,
      summaryMessage: formatRunStatusMessage({
        job: input.job,
        runId: input.runId,
        runShortId: input.runShortId,
        runStatus: input.runStatus,
        summary: input.summary,
        nextRun: input.nextRun,
        retryCount: input.retryCount,
        pauseReason: input.pauseReason,
        durationMs: input.durationMs,
      }),
    });
    if (retired === 'updated' || retired === undefined) return false;
  }
  // A review-created run sends the actual review card + Approve/Reject/Edit
  // buttons as a fresh terminal message. It deliberately bypasses the
  // lifecycle-update edit path (which would replace an existing progress
  // message with plain text and drop the buttons).
  if (input.memoryReviewNotification) {
    return sendMemoryReviewNotification({
      job: input.job,
      runId: input.runId,
      notification: input.memoryReviewNotification,
      sendMessage: input.sendMessage,
    });
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
      degradedReason: degradedReasonForDiagnostics(
        input.runStatus,
        input.diagnostics,
        input.pauseReason,
      ),
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

function degradedReasonForDiagnostics(
  runStatus: TerminalRunStatus,
  diagnostics: JobRunDiagnostics | undefined,
  pauseReason: string | null,
): string | undefined {
  if (runStatus !== 'completed' || !diagnostics) return undefined;
  // The denial that actually limited THIS run outranks a transient approval
  // note about future runs; show both when both happened.
  const parts: string[] = [];
  if (diagnostics.terminalToolDenial) {
    parts.push(
      `Missing ${humanizeTechnicalIdentifier(diagnostics.terminalToolDenial.toolName)} access limited this run.`,
    );
  }
  // The future-runs warning is emitted only when finalization actually
  // paused the job for setup — a completed one-shot run with an allow_once
  // has nothing to warn about. And since the setup card is suppressed on
  // this path, list EVERY distinct approval, not just the first: fixing one
  // and pausing again on the next would be the old loop in miniature.
  if (pauseReason === SETUP_REQUIRED_PAUSE_REASON) {
    const names = [
      ...new Set(
        diagnostics.transientPermissionApprovals.map((approval) =>
          humanizeTechnicalIdentifier(approval.toolName),
        ),
      ),
    ];
    if (names.length > 0) {
      parts.push(
        `${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} approved for this run only; future runs need permanent approval.`,
      );
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function reviewDecisionAffordances(
  view: ReviewMessageView,
): MessageActionAffordance[] {
  return view.affordances.map((affordance) => ({
    kind: 'memory_review_decision',
    label: affordance.label,
    reviewId: affordance.reviewId,
    decision: affordance.decision,
  }));
}

/**
 * Send the compact-structured review as a provider-native terminal notification.
 * The per-channel adapters render `reviewMessageView` as native blocks/card with
 * the three decision buttons; channels without native buttons fall back to the
 * plain `text` (compact structure + explicit reply-command). `actionAffordances`
 * carries the same buttons so they survive the durable-outbox path too.
 */
async function sendMemoryReviewNotification(input: {
  job: Job;
  runId: string;
  notification: MemoryReviewCreatedNotification;
  sendMessage: SchedulerSendMessage;
}): Promise<boolean> {
  const view = input.notification.reviewMessageView;
  // reviewMessageFallbackText already folds in the "＋N more pending" line from
  // view.morePendingCount, so the text fallback and native cards stay in sync.
  const text = reviewMessageFallbackText(view);
  return sendJobNotification({
    job: input.job,
    text,
    phase: 'summary',
    runId: input.runId,
    actionAffordances: reviewDecisionAffordances(view),
    reviewMessageView: view,
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
