import type { Job } from '../domain/types.js';
import {
  evaluateJobReadiness,
  SETUP_REQUIRED_PAUSE_REASON,
} from '../application/jobs/job-readiness-service.js';
import { agentIdForJobWorkspaceKey } from '../application/jobs/job-tool-policy.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
import { notifySchedulerSetupRequired } from './execution-notifications.js';
import { readImageCapabilityInventory } from '../shared/worker-image-inventory.js';
import { getDeploymentMode } from '../config/index.js';
import {
  getRuntimeEventExchange,
  getRuntimeRepositories,
  getRuntimeStorage,
  getWorkerCoordinationRepository,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  evaluateFleetCapabilityReadiness,
  fleetCapabilitySetupState,
} from './capability-readiness.js';
import type { SchedulerDependencies } from './types.js';
import {
  assertHostAccessSnapshot,
  type AgentAccessSnapshot,
} from '../application/agent-execution/agent-access-snapshot.js';
import { raiseSetupPausePermissionPrompt } from '../application/jobs/setup-pause-permission-prompt.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { JobSetupRequiredNotificationPort } from '../application/jobs/job-management-types.js';

type JobSetupCheckSource =
  | 'preflight_setup'
  | 'final_setup'
  | 'permission_denied'
  | 'permission_timeout'
  | 'transient_permission'
  | 'partial_recovery';

export async function pauseJobForSetupIfNeeded(input: {
  currentJob: Job;
  deps: SchedulerDependencies;
  executionAgentFolder: string;
  runtimeAppId: string;
  appSession?: SchedulerEventAppSession;
  agentId?: string;
  source?: JobSetupCheckSource;
  runId?: string | null;
  accessSnapshot?: AgentAccessSnapshot;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
}): Promise<boolean> {
  const appId = input.appSession?.appId ?? input.runtimeAppId;
  const agentId =
    input.agentId ?? agentIdForJobWorkspaceKey(input.executionAgentFolder);
  const accessSnapshot = assertHostAccessSnapshot({
    accessSnapshot: input.accessSnapshot,
    appId,
    agentId,
    subject: 'Job execution readiness',
  });

  // Fleet-wide capability gate first: pause ONLY when no active worker can
  // satisfy the job's required set (not on local-worker insufficiency, which
  // requeues to an eligible worker). Surfaces one clear user action.
  const fleetSetupState = await fleetCapabilitySetupStateIfUnsatisfiable({
    deps: input.deps,
    appId,
    agentId,
    accessSnapshot,
    previous: input.currentJob.setup_state,
  });
  if (fleetSetupState) {
    await pauseAndNotify({ ...input, setupState: fleetSetupState });
    return true;
  }

  const readiness = await evaluateJobReadiness({
    job: input.currentJob,
    appId,
    agentId,
    toolRepository: input.deps.getToolRepository?.(),
    skillRepository: input.deps.getSkillRepository?.(),
    mcpServerRepository: input.deps.getMcpServerRepository?.(),
    capabilitySecretRepository: input.deps.getCapabilitySecretRepository?.(),
    credentialBroker: await input.deps.getCredentialBroker?.(),
    getBrowserStatus: input.deps.getBrowserStatus,
    workerImageInventory: readImageCapabilityInventory(),
    accessSnapshot,
  });
  if (readiness.ready) return false;

  await pauseAndNotify({ ...input, setupState: readiness.setupState });
  return true;
}

/**
 * Fleet-wide capability readiness probe. Returns a user-actionable setup state
 * when the job's required capability set is non-empty and no active worker
 * advertises it; null otherwise (workstation, empty set, or satisfiable).
 */
async function fleetCapabilitySetupStateIfUnsatisfiable(input: {
  deps: SchedulerDependencies;
  appId: string;
  agentId: string;
  accessSnapshot?: AgentAccessSnapshot;
  previous?: Job['setup_state'];
}): Promise<Job['setup_state'] | null> {
  if (getDeploymentMode() !== 'fleet') return null;
  const fleet = await evaluateFleetCapabilityReadiness(
    {
      deploymentMode: 'fleet',
      skills: input.deps.getSkillRepository?.(),
      runtimeDependencies: getRuntimeStorage().repositories.runtimeDependencies,
      workerRegistry: getWorkerCoordinationRepository(),
    },
    {
      appId: input.appId,
      agentId: input.agentId,
      accessSnapshot: input.accessSnapshot,
    },
  );
  if (fleet.satisfiable) return null;
  return fleetCapabilitySetupState({
    missingCapabilities: fleet.missingCapabilities,
    previous: input.previous,
  });
}

async function pauseAndNotify(input: {
  currentJob: Job;
  deps: SchedulerDependencies;
  runtimeAppId: string;
  appSession?: SchedulerEventAppSession;
  source?: JobSetupCheckSource;
  runId?: string | null;
  setupState: NonNullable<Job['setup_state']>;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
}): Promise<void> {
  await input.deps.opsRepository.updateJob(input.currentJob.id, {
    status: 'paused',
    pause_reason: SETUP_REQUIRED_PAUSE_REASON,
    next_run: null,
    setup_state: input.setupState,
    lease_run_id: null,
    lease_expires_at: null,
  });
  await notifyJobSetupRequired({
    currentJob: input.currentJob,
    deps: input.deps,
    runtimeAppId: input.runtimeAppId,
    appSession: input.appSession,
    setupState: input.setupState,
    source: input.source ?? 'preflight_setup',
    runId: input.runId,
    publishRuntimeEvent: input.publishRuntimeEvent,
  });
  input.deps.onSchedulerChanged?.(input.currentJob.id);
}

export async function notifyJobSetupRequired(input: {
  currentJob: Job;
  deps: {
    sendMessage: SchedulerDependencies['sendMessage'];
    opsRepository: Pick<
      SchedulerDependencies['opsRepository'],
      'markJobSetupNotified'
    >;
  };
  runtimeAppId: string;
  appSession?: SchedulerEventAppSession;
  setupState: NonNullable<Job['setup_state']>;
  previousFingerprint?: string | null;
  source?: JobSetupCheckSource;
  runId?: string | null;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
  suppressNotification?: boolean;
}): Promise<boolean> {
  const notificationEligible =
    !input.suppressNotification &&
    !input.currentJob.silent &&
    input.setupState.notified_fingerprint !== input.setupState.fingerprint;
  let prompt: Awaited<ReturnType<typeof raiseSetupPausePermissionPrompt>> = {
    status: 'instruction_only',
    notificationEligible: true,
  };
  let promptPreparationFailed = false;
  if (notificationEligible) {
    try {
      prompt = await raiseSetupPausePermissionPrompt({
        jobId: input.currentJob.id,
        setupFingerprint: input.setupState.fingerprint,
        previousFingerprint:
          input.previousFingerprint ??
          input.currentJob.setup_state?.fingerprint,
        source: input.source,
        runId: input.runId,
      });
    } catch (err) {
      logger.warn(
        {
          err,
          jobId: input.currentJob.id,
          setupFingerprint: input.setupState.fingerprint,
        },
        'Failed to prepare setup-pause permission prompt; continuing with setup card',
      );
      promptPreparationFailed = true;
    }
  }
  const cardNotified = !notificationEligible
    ? false
    : prompt.status === 'instruction_only' &&
        prompt.notificationEligible === false
      ? false
      : await notifySchedulerSetupRequired({
          job: input.currentJob,
          setupState: input.setupState,
          source: input.source,
          runId: input.runId,
          ...(prompt.status === 'raised'
            ? { excludeRoute: prompt.approverRoute }
            : prompt.status === 'already_pending'
              ? { includeRoute: prompt.approverRoute }
              : {}),
          sendMessage: input.deps.sendMessage,
        });
  const promptNotified =
    prompt.status === 'raised' ? await prompt.delivered : false;
  const fallbackNotified =
    prompt.status === 'raised' && !promptNotified
      ? await notifySchedulerSetupRequired({
          job: {
            ...input.currentJob,
            notification_routes: [],
          },
          setupState: input.setupState,
          source: input.source,
          runId: input.runId,
          includeRoute: prompt.approverRoute,
          sendMessage: input.deps.sendMessage,
        })
      : false;
  const notified =
    prompt.status === 'raised'
      ? promptNotified || fallbackNotified
      : promptPreparationFailed
        ? false
        : cardNotified;
  if (notified) {
    await input.deps.opsRepository.markJobSetupNotified(
      input.currentJob.id,
      input.setupState.fingerprint,
    );
  }
  await input.publishRuntimeEvent({
    appId: (input.appSession?.appId ?? input.runtimeAppId) as never,
    eventType: RUNTIME_EVENT_TYPES.JOB_SETUP_REQUIRED,
    payload: {
      jobId: input.currentJob.id,
      setup_state: input.setupState.state,
      blocker_fingerprint: input.setupState.fingerprint,
      notified,
      blockers: input.setupState.blockers.map((blocker) => ({
        state: blocker.state,
        requirement_type: blocker.requirementType,
        requirement_id: blocker.requirementId,
        next_action: blocker.nextAction,
      })),
    },
    actor: 'scheduler',
    sessionId: input.appSession?.sessionId as never,
    jobId: input.currentJob.id as never,
    responseMode: input.appSession?.defaultResponseMode,
    webhookId: input.appSession?.defaultWebhookId,
  });
  return notified;
}

export async function notifyCreatedJobSetupRequired(input: {
  jobId: string;
  deps: {
    sendMessage: SchedulerDependencies['sendMessage'];
    opsRepository: Pick<
      SchedulerDependencies['opsRepository'],
      'getJobById' | 'markJobSetupNotified'
    >;
  };
  runtimeAppId: string;
  appSession?: SchedulerEventAppSession;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
}): Promise<boolean> {
  const currentJob = await input.deps.opsRepository.getJobById(input.jobId);
  if (!currentJob) return false;
  // This runs asynchronously after job creation, so the job may have been
  // resumed, re-evaluated, or already notified in the meantime. Revalidate
  // against the freshly loaded job and notify with ITS current setup state —
  // using the stale creation snapshot would bypass the notified-fingerprint
  // dedup and could deliver a duplicate or obsolete card.
  // ponytail: the notified-fingerprint dedup is check-then-mark, not an atomic
  // claim, so a job that is *run* within this sub-second window could still get a
  // second card from the scheduler's run-path notify. Near-unreachable for normal
  // future-scheduled jobs; atomic claim-before-send hardening is deferred (D-0053).
  const currentSetupState = currentJob.setup_state;
  if (!currentSetupState || currentSetupState.state === 'ready') {
    return false;
  }
  return notifyJobSetupRequired({
    currentJob,
    deps: input.deps,
    runtimeAppId: input.runtimeAppId,
    appSession: input.appSession,
    setupState: currentSetupState,
    source: 'preflight_setup',
    publishRuntimeEvent: input.publishRuntimeEvent,
  });
}

export function createJobSetupRequiredNotificationPort(
  sendMessage: SchedulerDependencies['sendMessage'],
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => void | Promise<void>,
): JobSetupRequiredNotificationPort {
  return {
    notify: (input) => {
      void notifyCreatedJobSetupRequired({
        jobId: input.jobId,
        deps: { sendMessage, opsRepository: getRuntimeRepositories() },
        runtimeAppId: input.appId,
        appSession: input.appSession
          ? {
              ...input.appSession,
              defaultResponseMode: input.appSession.defaultResponseMode ?? null,
            }
          : undefined,
        publishRuntimeEvent: async (event) => {
          await (publishRuntimeEvent
            ? publishRuntimeEvent(event)
            : getRuntimeEventExchange().publish(event));
        },
      }).catch((err) => {
        logger.warn(
          { err, jobId: input.jobId },
          'Failed to notify setup pause after job creation',
        );
      });
    },
  };
}
