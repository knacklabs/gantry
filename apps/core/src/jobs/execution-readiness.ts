import type { Job } from '../domain/types.js';
import {
  evaluateJobReadiness,
  SETUP_REQUIRED_PAUSE_REASON,
} from '../application/jobs/job-readiness-service.js';
import { agentIdForJobWorkspaceKey } from '../application/jobs/job-tool-policy.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { JobRecoveryIntentSource } from '../application/jobs/job-recovery-intent-service.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
import { notifySchedulerSetupRequired } from './execution-notifications.js';
import { readImageCapabilityInventory } from '../shared/worker-image-inventory.js';
import { getDeploymentMode } from '../config/index.js';
import {
  getRuntimeStorage,
  getWorkerCoordinationRepository,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  evaluateFleetCapabilityReadiness,
  fleetCapabilitySetupState,
} from './capability-readiness.js';
import type { SchedulerDependencies } from './types.js';

export async function pauseJobForSetupIfNeeded(input: {
  currentJob: Job;
  deps: SchedulerDependencies;
  executionAgentFolder: string;
  runtimeAppId: string;
  appSession?: SchedulerEventAppSession;
  agentId?: string;
  source?: JobRecoveryIntentSource;
  runId?: string | null;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
}): Promise<boolean> {
  const appId = input.appSession?.appId ?? input.runtimeAppId;
  const agentId =
    input.agentId ?? agentIdForJobWorkspaceKey(input.executionAgentFolder);

  // Fleet-wide capability gate first: pause ONLY when no active worker can
  // satisfy the job's required set (not on local-worker insufficiency, which
  // requeues to an eligible worker). Surfaces one clear user action.
  const fleetSetupState = await fleetCapabilitySetupStateIfUnsatisfiable({
    deps: input.deps,
    appId,
    agentId,
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
    { appId: input.appId, agentId: input.agentId },
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
  source?: JobRecoveryIntentSource;
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
  deps: SchedulerDependencies;
  runtimeAppId: string;
  appSession?: SchedulerEventAppSession;
  setupState: NonNullable<Job['setup_state']>;
  source?: JobRecoveryIntentSource;
  runId?: string | null;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
}): Promise<boolean> {
  const notified = await notifySchedulerSetupRequired({
    job: input.currentJob,
    setupState: input.setupState,
    sendMessage: input.deps.sendMessage,
  });
  if (notified) {
    await input.deps.opsRepository.updateJob(input.currentJob.id, {
      setup_state: {
        ...input.setupState,
        notified_fingerprint: input.setupState.fingerprint,
      },
    });
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
