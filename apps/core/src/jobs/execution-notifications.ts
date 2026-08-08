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
import {
  formatSchedulerSetupStory,
  type SchedulerSetupStorySource,
} from '../application/jobs/scheduler-setup-story.js';
import { humanizeTechnicalIdentifier } from '../shared/user-visible-messages.js';
import type { NormalizedJobNotificationRoute } from './job-notification-routes.js';

type TerminalRunStatus = Extract<
  JobRunStatus,
  'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered'
>;

export type JobNotificationLifecycleRouteStatus =
  | 'updated'
  | 'unsupported'
  | 'failed';

export interface JobNotificationLifecycleRouteOutcome {
  route: NormalizedJobNotificationRoute;
  status: JobNotificationLifecycleRouteStatus;
}

export type JobNotificationLifecycleUpdateResult =
  JobNotificationLifecycleRouteOutcome[];

export type { SchedulerSetupStorySource } from '../application/jobs/scheduler-setup-story.js';

const LIFECYCLE_EXIT_NOTIFICATION_TIMEOUT_MS = 5_000;

export function schedulerTerminalRunSummary(
  errorSummary: string | null,
  resultSummary: string | null,
): string {
  return errorSummary
    ? errorSummary.slice(0, 1_200)
    : resultSummary
      ? resultSummary.slice(0, 4_000)
      : 'Completed, no reportable output.';
}

export function createSchedulerLifecycleRetirementTracker(
  job: Job,
  runId: string,
  lifecycle: {
    updateLifecycleNotification?: (input: {
      job: Job;
      runId: string;
      runStatus: TerminalRunStatus;
      summaryMessage: string;
    }) => Promise<JobNotificationLifecycleUpdateResult>;
    discardLifecycleNotification?: (runId: string) => void;
  },
): {
  captureTerminal(runStatus: TerminalRunStatus, summaryMessage: string): void;
  updateLifecycleNotification: typeof lifecycle.updateLifecycleNotification;
  retire(deleted: boolean): Promise<void>;
} {
  let lifecycleRetired = false;
  let routesPendingRetirement: NormalizedJobNotificationRoute[] | undefined;
  let terminal:
    | { runStatus: TerminalRunStatus; summaryMessage: string }
    | undefined;
  const updateLifecycleNotification = lifecycle.updateLifecycleNotification
    ? async (
        input: Parameters<
          NonNullable<typeof lifecycle.updateLifecycleNotification>
        >[0],
      ) => {
        const outcomes = await lifecycle.updateLifecycleNotification!(input);
        routesPendingRetirement = outcomes
          .filter((outcome) => outcome.status !== 'updated')
          .map((outcome) => outcome.route);
        lifecycleRetired =
          outcomes.length > 0 && routesPendingRetirement.length === 0;
        return outcomes;
      }
    : undefined;
  return {
    captureTerminal: (runStatus, summaryMessage) => {
      terminal = { runStatus, summaryMessage };
    },
    updateLifecycleNotification,
    retire: async (deleted) => {
      try {
        const update =
          (!lifecycleRetired || deleted) &&
          lifecycle.updateLifecycleNotification?.({
            job:
              !deleted && routesPendingRetirement?.length
                ? { ...job, notification_routes: routesPendingRetirement }
                : job,
            runId,
            runStatus: deleted ? 'failed' : (terminal?.runStatus ?? 'failed'),
            summaryMessage: deleted
              ? `Job stopped: ${job.name} was deleted.`
              : terminal
                ? terminal.summaryMessage
                : `Job stopped unexpectedly: ${job.name}.`,
          });
        if (update) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            update.catch(() => undefined),
            new Promise<void>((resolve) => {
              timeout = setTimeout(
                resolve,
                LIFECYCLE_EXIT_NOTIFICATION_TIMEOUT_MS,
              );
              timeout.unref?.();
            }),
          ]).finally(() => clearTimeout(timeout));
        }
      } finally {
        lifecycle.discardLifecycleNotification?.(runId);
      }
    },
  };
}

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

function runAgainActionAffordances(input: {
  job: Job;
  runId: string;
}): MessageActionAffordance[] {
  if (input.job.schedule_type !== 'manual') return [];
  return [
    {
      kind: 'scheduler_run_now',
      label: 'Run again',
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

export async function notifySchedulerPermissionRecovery(input: {
  job: Job;
  recoveryTransitionId: string;
  sendMessage: SchedulerSendMessage;
}): Promise<boolean> {
  if (input.job.silent) return false;
  return sendJobNotification({
    job: input.job,
    text: `Job resumed and queued: ${input.job.name}.`,
    phase: 'summary',
    runId: permissionRecoveryNotificationRunId(input.recoveryTransitionId),
    sendMessage: input.sendMessage,
  });
}

export function permissionRecoveryNotificationRunId(
  recoveryTransitionId: string,
): string {
  return `permission-recovery:${recoveryTransitionId}`;
}

export async function notifySchedulerSetupRequired(input: {
  job: Job;
  setupState: JobSetupState;
  source?: SchedulerSetupStorySource;
  runId?: string | null;
  excludeRoute?: {
    conversationJid: string;
    threadId: string | null;
    providerAccountId?: string;
  };
  includeRoute?: {
    conversationJid: string;
    threadId: string | null;
    providerAccountId?: string;
  };
  sendMessage: SchedulerSendMessage;
}): Promise<boolean> {
  if (input.job.silent) return false;
  if (input.setupState.state === 'ready') return false;
  if (input.setupState.notified_fingerprint === input.setupState.fingerprint) {
    return false;
  }
  const includedJob = input.includeRoute
    ? withNotificationRoute(input.job, input.includeRoute)
    : input.job;
  const job = input.excludeRoute
    ? withoutNotificationRoute(includedJob, input.excludeRoute)
    : includedJob;
  if (!job) return false;
  return sendJobNotification({
    job,
    text: formatSchedulerSetupStory(input),
    phase: 'summary',
    runId: `setup:${input.setupState.fingerprint}`,
    sendMessage: input.sendMessage,
  });
}

function withNotificationRoute(
  job: Job,
  included: {
    conversationJid: string;
    threadId: string | null;
    providerAccountId?: string;
  },
): Job {
  const routes = job.notification_routes ?? [];
  if (routes.some((route) => routesMatch(route, included))) {
    return job;
  }
  return {
    ...job,
    notification_routes: [
      ...routes,
      {
        ...included,
        label: 'Setup approver',
      },
    ],
  };
}

function withoutNotificationRoute(
  job: Job,
  excluded: {
    conversationJid: string;
    threadId: string | null;
    providerAccountId?: string;
  },
): Job | null {
  if (job.notification_routes?.length) {
    const notificationRoutes = job.notification_routes.filter(
      (route) => !routesMatch(route, excluded),
    );
    return notificationRoutes.length > 0
      ? { ...job, notification_routes: notificationRoutes }
      : null;
  }
  const route = job.execution_context;
  return route?.conversationJid === excluded.conversationJid &&
    (route.threadId ?? job.thread_id ?? null) === excluded.threadId
    ? null
    : job;
}

function routesMatch(
  stored: {
    conversationJid: string;
    threadId: string | null;
    providerAccountId?: string | null;
  },
  resolved: {
    conversationJid: string;
    threadId: string | null;
    providerAccountId?: string;
  },
): boolean {
  return (
    stored.conversationJid === resolved.conversationJid &&
    stored.threadId === resolved.threadId &&
    // An omitted account means the resolved default account for this route.
    // An explicit account remains distinct from every other explicit account.
    (stored.providerAccountId ?? resolved.providerAccountId) ===
      resolved.providerAccountId
  );
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
  // The setup card is the single notification for a denied-tool / setup pause:
  // when it was actually delivered (setupNotified) and the run paused for setup
  // (pauseReason is set ONLY for setup denials by finalization — a robust
  // correlation, unlike re-parsing the summary), suppress the terminal card.
  // Exclude completed runs: a run that finished with only future runs paused
  // still needs its completed-with-limits outcome. Retire any in-place lifecycle
  // (running) message so it does not sit frozen at "running", then send nothing
  // further — no duplicate terminal card.
  if (
    input.runStatus !== 'completed' &&
    input.setupNotified === true &&
    input.pauseReason === SETUP_REQUIRED_PAUSE_REASON
  ) {
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
    const updateOutcomes =
      input.updateLifecycleNotification === undefined
        ? undefined
        : await input.updateLifecycleNotification({
            job: input.job,
            runId: input.runId,
            runStatus: input.runStatus,
            summaryMessage,
          });
    // No running message to retire -> the setup card is the single notification.
    // Otherwise reuse the lifecycle fallback: null when every route was edited
    // in place (no duplicate), or a routes-scoped job for backends that could
    // NOT edit the running message, so those routes still get a terminal card
    // instead of sitting frozen at "running".
    const staleJob =
      updateOutcomes === undefined || updateOutcomes.length === 0
        ? null
        : jobForLifecycleFallback(input.job, updateOutcomes);
    if (!staleJob) return false;
    return sendJobNotification({
      job: staleJob,
      text: summaryMessage,
      phase: 'summary',
      runId: input.runId,
      actionAffordances: [],
      sendMessage: input.sendMessage,
    });
  }
  // A review-created run retires its running progress message first, then
  // sends the actual review card + Approve/Reject/Edit buttons separately.
  if (input.memoryReviewNotification) {
    await input.updateLifecycleNotification?.({
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
  const updateOutcomes =
    input.updateLifecycleNotification === undefined
      ? undefined
      : await input.updateLifecycleNotification({
          job: input.job,
          runId: input.runId,
          runStatus: input.runStatus,
          summaryMessage,
        });
  const fallbackJob = jobForLifecycleFallback(input.job, updateOutcomes);
  const actionAffordances =
    input.runStatus === 'completed'
      ? runAgainActionAffordances({ job: input.job, runId: input.runId })
      : recoveryActionAffordances({ job: input.job, runId: input.runId });
  const notificationJob =
    actionAffordances.length > 0 ? input.job : fallbackJob;
  if (!notificationJob) return true;
  return sendJobNotification({
    job: notificationJob,
    text: summaryMessage,
    phase: 'summary',
    runId: input.runId,
    actionAffordances,
    sendMessage: input.sendMessage,
  });
}

function jobForLifecycleFallback(
  job: Job,
  outcomes: JobNotificationLifecycleUpdateResult | undefined,
): Job | null {
  if (outcomes === undefined) return job;
  if (outcomes.length === 0) return job;
  const routes = outcomes
    .filter((outcome) => outcome.status !== 'updated')
    .map((outcome) => outcome.route);
  if (routes.length === 0) return null;
  return {
    ...job,
    notification_routes: routes.map((route) => ({ ...route })),
  };
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
