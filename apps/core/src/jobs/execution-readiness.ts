import type { Job } from '../domain/types.js';
import {
  evaluateJobReadiness,
  SETUP_REQUIRED_PAUSE_REASON,
} from '../application/jobs/job-readiness-service.js';
import { agentIdForJobWorkspaceKey } from '../application/jobs/job-tool-policy.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
import { resolveAppSessionForJob } from './app-session-resolution.js';
import { notifySchedulerSetupRequired } from './execution-notifications.js';
import { readImageCapabilityInventory } from '../shared/worker-image-inventory.js';
import { getDeploymentMode } from '../config/index.js';
import {
  getRuntimeEventExchange,
  getRuntimeControlRepository,
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
      | 'markJobSetupNotified'
      | 'confirmJobSetupNotified'
      | 'clearJobSetupNotified'
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
    (input.setupState.notified_fingerprint !== input.setupState.fingerprint ||
      input.setupState.notify_claim_at != null);
  // The claim makes ordinary delivery exactly-once. Two abnormal windows are
  // intentionally at-least-once (a rare duplicate card, never a lost one):
  //  1. a crash after send but before confirmation leaves a reclaimable token;
  //  2. a delivery that hangs past the claim TTL is reclaimed by a successor.
  // This is the accepted ceiling: true exactly-once over a channel that can hang
  // needs a durable idempotent outbox / send-cancellation, which is
  // disproportionate for a setup card. The TTL is the deliberate tradeoff —
  // without it, a crashed claim would suppress the card permanently.
  // ponytail: revisit only if real duplicate cards or hung deliveries are seen.
  const claimAt = notificationEligible
    ? await input.deps.opsRepository.markJobSetupNotified(
        input.currentJob.id,
        input.setupState.fingerprint,
      )
    : null;
  if (notificationEligible && claimAt === null) {
    return false;
  }
  // The claim above persists notified_fingerprint before delivery. The card
  // sender (execution-notifications.ts) treats notified_fingerprint===fingerprint
  // as "already delivered", so hand it a delivery view with the fingerprint
  // cleared — otherwise the winning claimant would suppress its own card.
  // (raiseSetupPausePermissionPrompt reloads the job but does NOT gate on
  // notified_fingerprint, so the pending claim never makes the prompt ineligible.)
  const deliverySetupState = notificationEligible
    ? { ...input.setupState, notified_fingerprint: null }
    : input.setupState;
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
  let notified: boolean;
  try {
    const cardNotified = !notificationEligible
      ? false
      : prompt.status === 'instruction_only' &&
          prompt.notificationEligible === false
        ? false
        : await notifySchedulerSetupRequired({
            job: input.currentJob,
            setupState: deliverySetupState,
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
            setupState: deliverySetupState,
            source: input.source,
            runId: input.runId,
            includeRoute: prompt.approverRoute,
            sendMessage: input.deps.sendMessage,
          })
        : false;
    notified =
      prompt.status === 'raised'
        ? promptNotified || fallbackNotified
        : promptPreparationFailed
          ? false
          : cardNotified;
  } catch (err) {
    if (notificationEligible) {
      await input.deps.opsRepository.clearJobSetupNotified(
        input.currentJob.id,
        input.setupState.fingerprint,
        claimAt!,
      );
    }
    throw err;
  }
  if (notificationEligible) {
    if (notified) {
      await input.deps.opsRepository.confirmJobSetupNotified(
        input.currentJob.id,
        input.setupState.fingerprint,
        claimAt!,
      );
    } else {
      await input.deps.opsRepository.clearJobSetupNotified(
        input.currentJob.id,
        input.setupState.fingerprint,
        claimAt!,
      );
    }
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
      | 'getJobById'
      | 'markJobSetupNotified'
      | 'confirmJobSetupNotified'
      | 'clearJobSetupNotified'
    >;
    control?: Parameters<typeof resolveAppSessionForJob>[1];
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
  const currentSetupState = currentJob.setup_state;
  if (!currentSetupState || currentSetupState.state === 'ready') {
    return false;
  }
  const appSession =
    currentJob.session_id === input.appSession?.sessionId
      ? input.appSession
      : currentJob.session_id
        ? await resolveAppSessionForJob(
            currentJob,
            input.deps.control ?? getRuntimeControlRepository(),
          )
        : undefined;
  return notifyJobSetupRequired({
    currentJob,
    deps: input.deps,
    runtimeAppId: input.runtimeAppId,
    appSession,
    setupState: currentSetupState,
    source: 'preflight_setup',
    publishRuntimeEvent: input.publishRuntimeEvent,
  });
}

export function createJobSetupRequiredNotificationPort(
  sendMessage: SchedulerDependencies['sendMessage'],
  resolveOpsRepository: () => Pick<
    SchedulerDependencies['opsRepository'],
    | 'getJobById'
    | 'markJobSetupNotified'
    | 'confirmJobSetupNotified'
    | 'clearJobSetupNotified'
  >,
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => void | Promise<void>,
): JobSetupRequiredNotificationPort {
  return {
    notify: (input) => {
      void notifyCreatedJobSetupRequired({
        jobId: input.jobId,
        // Resolve the repository lazily at notify time (not at construction) and
        // bind to the one the creating service actually persists through, so the
        // freshly created job is readable in dependency-injected / alternate-
        // storage compositions without forcing storage to exist at bootstrap.
        deps: {
          sendMessage,
          opsRepository: resolveOpsRepository(),
          control: getRuntimeControlRepository(),
        },
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
