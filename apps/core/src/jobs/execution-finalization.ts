import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { Job } from '../domain/types.js';
import {
  SETUP_REQUIRED_PAUSE_REASON,
  setupStateForDeniedTool,
  setupStateForTransientPermission,
} from '../application/jobs/job-readiness-service.js';
import { parseAutonomousToolDenial } from '../shared/autonomous-tool-denial.js';
import { redactProviderSessionHandlesInText } from '../shared/provider-session-redaction.js';
import { nowMs, toIso } from '../shared/time/datetime.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
import { computeNextJobRun } from './schedule-math.js';
import {
  formatTerminalDiagnostics,
  type JobRunDiagnostics,
} from './execution-diagnostics.js';
import { notifyJobSetupRequired } from './execution-readiness.js';
import type { SchedulerDependencies } from './types.js';

const MAX_RETRY_BACKOFF_MS = 30 * 24 * 60 * 60 * 1000;

export type SchedulerRunStatus =
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'dead_lettered';

export interface FinalizedJobRunState {
  runStatus: SchedulerRunStatus;
  nextRun: string | null;
  retryCount: number;
  pauseReason: string | null;
  safeErrorSummary: string | null;
  toolDenial: ReturnType<typeof parseAutonomousToolDenial>;
}

export async function finalizeSchedulerJobRun(input: {
  currentJob: Job;
  deps: SchedulerDependencies;
  scheduledFor: string;
  now: string;
  error: string | null;
  diagnostics: JobRunDiagnostics;
  pausedForSetupDuringRun: boolean;
  setupStateForSetupPause?: NonNullable<Job['setup_state']>;
  deletedDuringRun: boolean;
  runtimeAppId: string;
  runId: string;
  appSession?: SchedulerEventAppSession;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
  beforeJobStateUpdate?: (state: FinalizedJobRunState) => Promise<void>;
  updateJobState?: (
    updates: Partial<Job>,
    state: FinalizedJobRunState,
  ) => Promise<void>;
}): Promise<FinalizedJobRunState> {
  const {
    currentJob,
    deps,
    diagnostics,
    pausedForSetupDuringRun,
    runtimeAppId,
    appSession,
  } = input;
  const nextRunOnSuccess = computeNextJobRun(currentJob, input.scheduledFor);
  let runStatus: SchedulerRunStatus = 'completed';
  let nextRun: string | null = nextRunOnSuccess;
  let retryCount = currentJob.consecutive_failures;
  let pauseReason: string | null = null;
  const safePrimaryErrorSummary = input.error
    ? redactProviderSessionHandlesInText(input.error)
    : null;
  const diagnosticToolDenial = diagnostics.terminalToolDenial
    ? {
        toolName: diagnostics.terminalToolDenial.toolName,
        recoveryAction: diagnostics.terminalToolDenial.recoveryAction,
      }
    : null;
  const toolDenial =
    parseAutonomousToolDenial(safePrimaryErrorSummary) ?? diagnosticToolDenial;
  const transientPermissionApproval =
    diagnostics.transientPermissionApprovals[0] ?? null;
  const safeErrorSummary = safePrimaryErrorSummary
    ? `${safePrimaryErrorSummary}\nDiagnostics: ${formatTerminalDiagnostics(diagnostics)}`
    : null;
  let beforeJobStateUpdateCalled = false;
  const beforeJobStateUpdate = async (): Promise<void> => {
    if (beforeJobStateUpdateCalled) return;
    beforeJobStateUpdateCalled = true;
    await input.beforeJobStateUpdate?.({
      runStatus,
      nextRun,
      retryCount,
      pauseReason,
      safeErrorSummary,
      toolDenial,
    });
  };
  const updateJob = async (updates: Partial<Job>): Promise<void> => {
    const state = {
      runStatus,
      nextRun,
      retryCount,
      pauseReason,
      safeErrorSummary,
      toolDenial,
    };
    await beforeJobStateUpdate();
    if (input.updateJobState) {
      await input.updateJobState(updates, state);
      return;
    }
    await deps.opsRepository.updateJob(currentJob.id, updates);
  };

  if (input.deletedDuringRun) {
    nextRun = null;
  } else if (input.error) {
    if (pausedForSetupDuringRun) {
      runStatus = 'failed';
      nextRun = null;
      pauseReason = SETUP_REQUIRED_PAUSE_REASON;
      const setupState = input.setupStateForSetupPause;
      await updateJob({
        status: 'paused',
        next_run: null,
        last_run: input.now,
        consecutive_failures: retryCount,
        pause_reason: pauseReason,
        ...(setupState ? { setup_state: setupState } : {}),
        lease_run_id: null,
        lease_expires_at: null,
      });
      if (setupState) {
        await notifyJobSetupRequired({
          currentJob,
          deps,
          runtimeAppId,
          appSession,
          setupState,
          source: 'preflight_setup',
          runId: input.runId,
          publishRuntimeEvent: input.publishRuntimeEvent,
        });
      }
    } else {
      retryCount += 1;
      runStatus = /timed out|deadline exceeded/i.test(input.error)
        ? 'timeout'
        : 'failed';
    }
    if (!pausedForSetupDuringRun && toolDenial) {
      runStatus = 'failed';
      const setupState = setupStateForDeniedTool({
        toolName: toolDenial.toolName,
        recoveryAction: toolDenial.recoveryAction,
        checkedAt: input.now,
        previous: currentJob.setup_state,
      });
      await updateJob({
        status: 'paused',
        next_run: null,
        last_run: input.now,
        consecutive_failures: retryCount,
        pause_reason: SETUP_REQUIRED_PAUSE_REASON,
        setup_state: setupState,
        lease_run_id: null,
        lease_expires_at: null,
      });
      await notifyJobSetupRequired({
        currentJob,
        deps,
        runtimeAppId,
        appSession,
        setupState,
        source: isPermissionTimeout(
          safePrimaryErrorSummary,
          diagnostics.terminalToolDenial?.reason,
        )
          ? 'permission_timeout'
          : 'permission_denied',
        runId: input.runId,
        publishRuntimeEvent: input.publishRuntimeEvent,
      });
      nextRun = null;
      pauseReason = SETUP_REQUIRED_PAUSE_REASON;
      if (currentJob.schedule_type === 'manual') {
        deps.onSchedulerChanged?.(currentJob.id);
      }
    } else if (
      !pausedForSetupDuringRun &&
      currentJob.schedule_type === 'manual'
    ) {
      nextRun = null;
      await updateJob({
        status: 'active',
        next_run: null,
        last_run: input.now,
        consecutive_failures: retryCount,
        pause_reason: null,
        lease_run_id: null,
        lease_expires_at: null,
      });
    } else if (!pausedForSetupDuringRun) {
      const exceededRetry = retryCount > currentJob.max_retries;
      const exceededConsecutive =
        retryCount >= currentJob.max_consecutive_failures;
      if (exceededRetry || exceededConsecutive) {
        runStatus = 'dead_lettered';
        nextRun = null;
        // Keep the user-facing pause reason generic + actionable. The detailed
        // (redacted) error lives on the run record / logs — embedding it here
        // leaked raw exception text and filesystem paths into the chat notification.
        pauseReason = `Paused after ${retryCount} failures. Fix the blocker, then resume the job.`;
        await updateJob({
          status: 'dead_lettered',
          next_run: null,
          last_run: input.now,
          consecutive_failures: retryCount,
          pause_reason: pauseReason,
          lease_run_id: null,
          lease_expires_at: null,
        });
      } else {
        nextRun = toIso(nowMs() + retryBackoffMs(currentJob, retryCount));
        await updateJob({
          status: 'active',
          next_run: nextRun,
          last_run: input.now,
          consecutive_failures: retryCount,
          pause_reason: null,
          lease_run_id: null,
          lease_expires_at: null,
        });
      }
    }
  } else if (
    transientPermissionApproval &&
    currentJob.schedule_type !== 'manual'
  ) {
    nextRun = null;
    pauseReason = SETUP_REQUIRED_PAUSE_REASON;
    const setupState = setupStateForTransientPermission({
      toolName: transientPermissionApproval.toolName,
      mode: transientPermissionApproval.mode,
      ...(transientPermissionApproval.recoveryAction
        ? { recoveryAction: transientPermissionApproval.recoveryAction }
        : {}),
      checkedAt: input.now,
      previous: currentJob.setup_state,
    });
    await updateJob({
      status: 'paused',
      next_run: null,
      last_run: input.now,
      consecutive_failures: 0,
      pause_reason: pauseReason,
      setup_state: setupState,
      lease_run_id: null,
      lease_expires_at: null,
    });
    await notifyJobSetupRequired({
      currentJob,
      deps,
      runtimeAppId,
      appSession,
      setupState,
      source: 'transient_permission',
      runId: input.runId,
      publishRuntimeEvent: input.publishRuntimeEvent,
    });
  } else {
    await updateJob({
      status:
        currentJob.schedule_type === 'manual' || nextRunOnSuccess
          ? 'active'
          : 'completed',
      next_run: nextRunOnSuccess,
      last_run: input.now,
      consecutive_failures: 0,
      pause_reason: null,
      lease_run_id: null,
      lease_expires_at: null,
    });
  }

  return {
    runStatus,
    nextRun,
    retryCount,
    pauseReason,
    safeErrorSummary,
    toolDenial,
  };
}

export function retryBackoffMs(job: Job, retryCount: number): number {
  const baseBackoff = Math.max(0, job.retry_backoff_ms || 0);
  const exponent = Math.max(0, retryCount - 1);
  const cappedExponent = Math.min(exponent, 30);
  const multiplier = Math.max(1, 2 ** cappedExponent);
  const rawDelay = baseBackoff * multiplier;
  return Number.isFinite(rawDelay)
    ? Math.min(rawDelay, MAX_RETRY_BACKOFF_MS)
    : MAX_RETRY_BACKOFF_MS;
}

function isPermissionTimeout(
  errorSummary: string | null,
  denialReason?: string,
): boolean {
  return /timed out waiting|permission approval.*timed out|approval timeout/i.test(
    [errorSummary, denialReason].filter(Boolean).join(' '),
  );
}
