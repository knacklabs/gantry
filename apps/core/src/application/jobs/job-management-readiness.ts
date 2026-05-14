import type { Job } from '../../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from './job-access.js';
import type { JobManagementServiceDeps } from './job-management-types.js';
import {
  evaluateJobReadiness,
  type JobReadinessInput,
  type JobReadinessResult,
  SETUP_REQUIRED_PAUSE_REASON,
} from './job-readiness-service.js';

export async function evaluateManagedJobReadiness(input: {
  deps: JobManagementServiceDeps;
  job: JobReadinessInput['job'] & Partial<Pick<Job, 'session_id'>>;
  appId?: string;
  agentId?: string;
}): Promise<JobReadinessResult> {
  return evaluateJobReadiness({
    job: input.job,
    appId: await resolveJobReadinessAppId({
      deps: input.deps,
      job: input.job,
      appId: input.appId,
    }),
    agentId: input.agentId,
    toolRepository: input.deps.toolRepository,
    mcpServerRepository: input.deps.mcpServerRepository,
    credentialBroker: await input.deps.getCredentialBroker?.(),
    getBrowserStatus: input.deps.getBrowserStatus,
    clock: input.deps.clock,
  });
}

export function applyJobReadinessToUpdates(
  updates: Partial<Job>,
  readiness: JobReadinessResult,
  options: {
    clearPauseWhenActive?: boolean;
    mergedStatus?: Job['status'];
  } = {},
): void {
  updates.setup_state = readiness.setupState;
  if (!readiness.ready) {
    updates.status = 'paused';
    updates.pause_reason = SETUP_REQUIRED_PAUSE_REASON;
    updates.next_run = null;
    return;
  }
  if (options.clearPauseWhenActive && options.mergedStatus === 'active') {
    updates.pause_reason = null;
  }
}

export async function pauseJobForSetup(input: {
  deps: JobManagementServiceDeps;
  job: Job;
  readiness: JobReadinessResult;
  appId?: string;
}): Promise<void> {
  await input.deps.ops.updateJob(input.job.id, {
    status: 'paused',
    pause_reason: SETUP_REQUIRED_PAUSE_REASON,
    next_run: null,
    setup_state: input.readiness.setupState,
    lease_run_id: null,
    lease_expires_at: null,
  });
  await recordJobSetupRequired(input);
  input.deps.scheduler.requestSchedulerSync(input.job.id);
}

export async function recordJobSetupRequired(input: {
  deps: JobManagementServiceDeps;
  job: Pick<Job, 'id' | 'group_scope'> &
    Partial<Pick<Job, 'session_id' | 'execution_context' | 'thread_id'>>;
  readiness: JobReadinessResult;
  appId?: string;
}): Promise<void> {
  if (input.readiness.ready || !input.deps.runtimeEvents) return;
  const appSession = input.job.session_id
    ? await input.deps.control?.getAppSessionById(input.job.session_id)
    : undefined;
  const appId = appSession?.appId ?? input.appId ?? DEFAULT_JOB_RUNTIME_APP_ID;
  await input.deps.runtimeEvents.publish({
    appId: appId as never,
    eventType: RUNTIME_EVENT_TYPES.JOB_SETUP_REQUIRED,
    actor: 'scheduler',
    sessionId: appSession?.sessionId as never,
    jobId: input.job.id as never,
    conversationId: input.job.execution_context?.conversationJid as never,
    threadId: (input.job.execution_context?.threadId ??
      input.job.thread_id ??
      null) as never,
    responseMode: appSession?.defaultResponseMode,
    webhookId: appSession?.defaultWebhookId,
    payload: {
      jobId: input.job.id,
      setup_state: input.readiness.setupState.state,
      blocker_fingerprint: input.readiness.setupState.fingerprint,
      notified: false,
      blockers: input.readiness.setupState.blockers,
    },
  });
}

export function setupBlockerDetails(
  setupState: NonNullable<Job['setup_state']>,
): string[] {
  return setupState.blockers.map(
    (blocker) => `${blocker.message} Next action: ${blocker.nextAction}`,
  );
}

async function resolveJobReadinessAppId(input: {
  deps: JobManagementServiceDeps;
  job: Partial<Pick<Job, 'session_id'>>;
  appId?: string;
}): Promise<string | undefined> {
  if (input.appId) return input.appId;
  if (!input.job.session_id) return undefined;
  const session = await input.deps.control?.getAppSessionById(
    input.job.session_id,
  );
  return session?.appId ?? `unresolved:${input.job.session_id}`;
}
