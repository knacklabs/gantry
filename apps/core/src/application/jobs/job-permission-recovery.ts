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

export interface RecheckPausedJobsAfterCapabilityUpdateInput {
  appId?: string;
  sourceAgentFolder: string;
  conversationJid?: string;
  jobId?: string;
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
  const candidates = await listCandidateJobs(input);
  const now = input.clock?.now() ?? nowIso();
  const queued: RecheckedSetupJob[] = [];
  const stillBlocked: RecheckedSetupJob[] = [];
  for (const job of candidates) {
    if (!isSetupPausedJob(job)) continue;
    if (job.recovery_intent?.state === 'running') {
      stillBlocked.push({
        jobId: job.id,
        name: job.name,
        state: 'still_blocked',
        nextAction: 'Recovery is already running for this job.',
      });
      await publishRecheckEvent(input, job, 'still_blocked', job.setup_state);
      continue;
    }
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
      await input.opsRepository.updateJob(job.id, {
        status: 'active',
        pause_reason: null,
        next_run: now,
        setup_state: readiness.setupState,
        recovery_intent: null,
        lease_run_id: null,
        lease_expires_at: null,
      });
      input.scheduler.requestSchedulerSync(job.id);
      queued.push({ jobId: job.id, name: job.name, state: 'queued' });
      await publishRecheckEvent(input, job, 'queued', readiness.setupState);
      continue;
    }
    await input.opsRepository.updateJob(job.id, {
      status: 'paused',
      pause_reason: SETUP_REQUIRED_PAUSE_REASON,
      next_run: null,
      setup_state: readiness.setupState,
      lease_run_id: null,
      lease_expires_at: null,
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
  }
  return {
    checked: queued.length + stillBlocked.length,
    queued,
    stillBlocked,
  };
}

async function listCandidateJobs(
  input: RecheckPausedJobsAfterCapabilityUpdateInput,
): Promise<Job[]> {
  if (input.jobId) {
    const job = await input.opsRepository.getJobById(input.jobId);
    return job && jobMatchesCapabilityRecoveryScope(job, input) ? [job] : [];
  }
  const filters: JobListFilters = {
    statuses: ['paused'],
    workspaceKey: input.sourceAgentFolder,
    limit: 100,
  };
  if (input.conversationJid) filters.conversationJid = input.conversationJid;
  return input.opsRepository.listJobs(filters);
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
