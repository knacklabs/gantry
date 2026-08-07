import type { Job } from '../../domain/types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type {
  RuntimeJobRepository,
  JobListFilters,
} from '../../domain/repositories/ops-repo.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { SchedulerCoordinationPort } from './scheduler-coordination-port.js';
import {
  evaluateJobReadiness,
  SETUP_REQUIRED_PAUSE_REASON,
  type JobReadinessBrowserStatus,
} from './job-readiness-service.js';
import { agentIdForJobWorkspaceKey } from './job-tool-policy.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  raiseSetupPausePermissionPrompt,
  retireSetupPausePermissionPrompt,
  setupPausePermissionRequestId,
} from './setup-pause-permission-prompt.js';
import { logger } from '../../infrastructure/logging/logger.js';

export interface RecheckPausedJobsAfterCapabilityUpdateInput {
  appId?: string;
  sourceAgentFolder: string;
  conversationJid?: string;
  jobId?: string;
  recoveringPermissionRequestId?: string;
  opsRepository: RuntimeJobRepository;
  scheduler: SchedulerCoordinationPort;
  toolRepository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  mcpServerRepository?: McpServerRepository;
  capabilitySecretRepository?: CapabilitySecretRepository;
  credentialBroker?: AgentCredentialBroker;
  getBrowserStatus?: (
    profileName: string,
  ) => Promise<JobReadinessBrowserStatus | undefined>;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  sendQueuedReceipt?: (
    job: Job,
    recoveryTransitionId: string,
  ) => Promise<unknown> | unknown;
  clock?: { now(): string };
}

export interface RecheckedSetupJob {
  jobId: string;
  name: string;
  state: 'queued' | 'still_blocked';
  nextAction?: string;
}

export interface PausedJobCapabilityRecheckResult {
  checked: number;
  queued: RecheckedSetupJob[];
  stillBlocked: RecheckedSetupJob[];
}

export async function recheckSetupPausedJobsAfterCapabilityUpdate(
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
): Promise<PausedJobCapabilityRecheckResult> {
  const now = input.clock?.now() ?? nowIso();
  const queued: RecheckedSetupJob[] = [];
  const stillBlocked: RecheckedSetupJob[] = [];
  let pageAfter: JobListFilters['pageAfter'];
  do {
    const candidates = await listCandidateJobs(input, pageAfter);
    for (const job of candidates) {
      await recheckCandidateJob(input, job, now, queued, stillBlocked);
    }
    const last = candidates.at(-1);
    pageAfter =
      !input.jobId && candidates.length === RECOVERY_PAGE_SIZE && last
        ? {
            createdAt: last.created_at,
            id: last.id,
          }
        : undefined;
  } while (pageAfter);
  return {
    checked: queued.length + stillBlocked.length,
    queued,
    stillBlocked,
  };
}

async function recheckCandidateJob(
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
  initialJob: Job,
  now: string,
  queued: RecheckedSetupJob[],
  stillBlocked: RecheckedSetupJob[],
): Promise<void> {
  let job = initialJob;
  for (let attempt = 0; attempt <= RECOVERY_CAS_RETRY_LIMIT; attempt += 1) {
    if (!isSetupPausedJob(job)) return;
    const readiness = await evaluateJobReadiness({
      job,
      appId: input.appId,
      agentId: agentIdForJobWorkspaceKey(input.sourceAgentFolder),
      toolRepository: input.toolRepository,
      skillRepository: input.skillRepository,
      mcpServerRepository: input.mcpServerRepository,
      capabilitySecretRepository: input.capabilitySecretRepository,
      credentialBroker: input.credentialBroker,
      getBrowserStatus: input.getBrowserStatus,
      clock: input.clock,
    });
    if (readiness.ready) {
      const recoveryTransitionId =
        job.setup_state?.checked_at ?? job.updated_at;
      const claimed = await input.opsRepository.resumeSetupPausedJob({
        jobId: job.id,
        expectedSetupCheckedAt: recoveryTransitionId,
        expectedPauseReason: SETUP_REQUIRED_PAUSE_REASON,
        nextRun: now,
        setupState: readiness.setupState,
      });
      if (!claimed) {
        if (attempt === RECOVERY_CAS_RETRY_LIMIT) {
          input.scheduler.requestSchedulerSync(job.id);
          return;
        }
        const reread = await rereadCandidateJob(input, job.id);
        if (!reread) return;
        if (!isSetupPausedJob(reread)) {
          requestSyncForConcurrentReadyJob(input, reread);
          return;
        }
        job = reread;
        continue;
      }
      queued.push({ jobId: job.id, name: job.name, state: 'queued' });
      try {
        if (
          input.recoveringPermissionRequestId !==
          setupPausePermissionRequestId(job.id, job.setup_state!.fingerprint)
        ) {
          try {
            await retireSetupPausePermissionPrompt({
              job,
              reason:
                'The job setup requirement was resolved by another grant.',
            });
          } catch (err) {
            logger.warn(
              { err, jobId: job.id },
              'Failed to retire setup-pause permission prompt after job recovery',
            );
          }
        }
        await sendQueuedReceipt(input, job, recoveryTransitionId);
        await publishRecheckEvent(input, job, 'queued', readiness.setupState);
      } finally {
        input.scheduler.requestSchedulerSync(job.id);
      }
      return;
    }
    const previousFingerprint = job.setup_state?.fingerprint;
    const refreshed = await input.opsRepository.refreshSetupPausedJob({
      jobId: job.id,
      expectedSetupCheckedAt: job.setup_state?.checked_at ?? job.updated_at,
      expectedPauseReason: SETUP_REQUIRED_PAUSE_REASON,
      setupState: readiness.setupState,
    });
    if (!refreshed) {
      if (attempt === RECOVERY_CAS_RETRY_LIMIT) {
        input.scheduler.requestSchedulerSync(job.id);
        return;
      }
      const reread = await rereadCandidateJob(input, job.id);
      if (!reread) return;
      if (!isSetupPausedJob(reread)) {
        requestSyncForConcurrentReadyJob(input, reread);
        return;
      }
      job = reread;
      continue;
    }
    await notifyStillBlockedSetupPrompt({
      recheckInput: input,
      job,
      setupState: readiness.setupState,
      previousFingerprint,
    });
    stillBlocked.push({
      jobId: job.id,
      name: job.name,
      state: 'still_blocked',
      nextAction: readiness.setupState.blockers[0]?.nextAction,
    });
    await publishRecheckEvent(
      input,
      job,
      'still_blocked',
      readiness.setupState,
    );
    return;
  }
}

async function rereadCandidateJob(
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
  jobId: string,
): Promise<Job | undefined> {
  const job = await input.opsRepository.getJobById(jobId);
  return job && jobMatchesCapabilityRecoveryScope(job, input) ? job : undefined;
}

function requestSyncForConcurrentReadyJob(
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
  job: Job,
): void {
  if (job.status === 'active' || job.setup_state?.state === 'ready') {
    input.scheduler.requestSchedulerSync(job.id);
  }
}

async function notifyStillBlockedSetupPrompt(notification: {
  recheckInput: RecheckPausedJobsAfterCapabilityUpdateInput;
  job: Job;
  setupState: NonNullable<Job['setup_state']>;
  previousFingerprint?: string;
}): Promise<void> {
  if (
    notification.setupState.notified_fingerprint ===
    notification.setupState.fingerprint
  ) {
    return;
  }
  try {
    const prompt = await raiseSetupPausePermissionPrompt({
      jobId: notification.job.id,
      setupFingerprint: notification.setupState.fingerprint,
      previousFingerprint: notification.previousFingerprint,
      source: 'partial_recovery',
    });
    if (prompt.status !== 'raised' || !(await prompt.delivered)) return;
    await notification.recheckInput.opsRepository.markJobSetupNotified(
      notification.job.id,
      notification.setupState.fingerprint,
    );
  } catch (err) {
    logger.warn(
      { err, jobId: notification.job.id },
      'Failed to notify setup pause after partial recovery',
    );
  }
}

async function listCandidateJobs(
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
  pageAfter?: JobListFilters['pageAfter'],
): Promise<Job[]> {
  if (input.jobId) {
    const job = await input.opsRepository.getJobById(input.jobId);
    return job && jobMatchesCapabilityRecoveryScope(job, input) ? [job] : [];
  }
  const filters: JobListFilters = {
    statuses: ['paused'],
    workspaceKey: input.sourceAgentFolder,
    limit: RECOVERY_PAGE_SIZE,
    orderBy: 'created_at',
    ...(pageAfter ? { pageAfter } : {}),
  };
  if (input.conversationJid) filters.conversationJid = input.conversationJid;
  return input.opsRepository.listJobs(filters);
}

const RECOVERY_PAGE_SIZE = 100;
const RECOVERY_CAS_RETRY_LIMIT = 1;

async function sendQueuedReceipt(
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
  job: Job,
  recoveryTransitionId: string,
): Promise<void> {
  try {
    await input.sendQueuedReceipt?.(job, recoveryTransitionId);
  } catch {
    // The durable resume wins even when its visible receipt cannot be sent.
  }
}

function jobMatchesCapabilityRecoveryScope(
  job: Job,
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
): boolean {
  if (job.workspace_key !== input.sourceAgentFolder) return false;
  const executionContext = job.execution_context;
  if (
    executionContext?.workspaceKey &&
    executionContext.workspaceKey !== input.sourceAgentFolder
  ) {
    return false;
  }
  if (!input.conversationJid) return true;
  return executionContext?.conversationJid === input.conversationJid;
}

function isSetupPausedJob(job: Job): boolean {
  return (
    job.status === 'paused' &&
    job.pause_reason === SETUP_REQUIRED_PAUSE_REASON &&
    job.setup_state?.state !== 'ready'
  );
}

async function publishRecheckEvent(
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
  job: Job,
  outcome: 'queued' | 'still_blocked',
  setupState: Job['setup_state'],
): Promise<void> {
  if (!input.publishRuntimeEvent || !input.appId) return;
  try {
    await input.publishRuntimeEvent({
      appId: input.appId as never,
      eventType: RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
      actor: 'permission',
      jobId: job.id as never,
      conversationId: job.execution_context?.conversationJid as never,
      threadId: (job.execution_context?.threadId ?? job.thread_id) as never,
      payload: {
        jobId: job.id,
        permissionRecovery: outcome,
        setup_state: setupState?.state,
        blocker_fingerprint: setupState?.fingerprint,
      },
    });
  } catch {
    // Rechecking paused setup must not fail because telemetry is unavailable.
  }
}
