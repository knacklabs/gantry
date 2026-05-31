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
import { resolveExecutionContext } from './execution-context.js';
import { notifySchedulerSetupRequired } from './execution-notifications.js';
import { queueJobRecoveryTurn } from './recovery.js';
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
  const readiness = await evaluateJobReadiness({
    job: input.currentJob,
    appId: input.appSession?.appId ?? input.runtimeAppId,
    agentId:
      input.agentId ?? agentIdForJobWorkspaceKey(input.executionAgentFolder),
    toolRepository: input.deps.getToolRepository?.(),
    skillRepository: input.deps.getSkillRepository?.(),
    mcpServerRepository: input.deps.getMcpServerRepository?.(),
    capabilitySecretRepository: input.deps.getCapabilitySecretRepository?.(),
    credentialBroker: await input.deps.getCredentialBroker?.(),
    getBrowserStatus: input.deps.getBrowserStatus,
  });
  if (readiness.ready) return false;

  const setupState = readiness.setupState;
  await input.deps.opsRepository.updateJob(input.currentJob.id, {
    status: 'paused',
    pause_reason: SETUP_REQUIRED_PAUSE_REASON,
    next_run: null,
    setup_state: setupState,
    lease_run_id: null,
    lease_expires_at: null,
  });
  await notifyJobSetupRequired({
    currentJob: input.currentJob,
    deps: input.deps,
    runtimeAppId: input.runtimeAppId,
    appSession: input.appSession,
    setupState,
    source: input.source ?? 'preflight_setup',
    runId: input.runId,
    publishRuntimeEvent: input.publishRuntimeEvent,
  });
  input.deps.onSchedulerChanged?.(input.currentJob.id);
  return true;
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
  const execution = resolveExecutionContext(
    input.currentJob,
    input.deps.conversationRoutes(),
  );
  if (execution) {
    await queueJobRecoveryTurn({
      currentJob: input.currentJob,
      deps: input.deps,
      execution,
      setupState: input.setupState,
      source: input.source ?? 'preflight_setup',
      runId: input.runId,
      runtimeAppId: input.runtimeAppId,
      publishRuntimeEvent: input.publishRuntimeEvent,
    });
  }
  return notified;
}
