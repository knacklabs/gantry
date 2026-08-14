import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { IpcDeps } from '../../runtime/ipc-domain-types.js';
import type { JobReadinessBrowserStatus } from '../../application/jobs/job-readiness-service.js';
import {
  startCapabilityTemplateApprovalIntentRecoveryLoop,
  type CapabilityTemplateApprovalTargetOutcome,
} from '../../jobs/capability-template-approval-intent-recovery.js';
import { recheckPausedSetupJobsAfterRequestAccessGrant } from '../../jobs/request-access-job-recovery.js';
import { SETUP_REQUIRED_PAUSE_REASON } from '../../domain/jobs/jobs.js';
import type { CapabilityTemplateApprovalIntentRepository } from '../../shared/capability-template-amendment.js';

export function capabilityTemplateApprovalIntentRepositoryFrom(
  repositories: unknown,
): CapabilityTemplateApprovalIntentRepository | undefined {
  if (!repositories || typeof repositories !== 'object') return undefined;
  const candidate = (
    repositories as {
      capabilityTemplateAmendments?: Partial<CapabilityTemplateApprovalIntentRepository>;
    }
  ).capabilityTemplateAmendments;
  return candidate &&
    typeof candidate.claimDueApprovalIntents === 'function' &&
    typeof candidate.settleApprovalIntentClaim === 'function'
    ? (candidate as CapabilityTemplateApprovalIntentRepository)
    : undefined;
}

export function startRuntimeCapabilityTemplateApprovalIntentRecovery(input: {
  repositories: unknown;
  opsRepository: IpcDeps['opsRepository'];
  getToolRepository: () => ToolCatalogRepository;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  getBrowserStatus?: (
    profileName: string,
  ) => Promise<JobReadinessBrowserStatus | undefined>;
  publishRuntimeEvent?: IpcDeps['publishRuntimeEvent'];
  onSchedulerChanged(jobId?: string): void;
  sendMessage: IpcDeps['sendMessage'];
  warn(meta: Record<string, unknown>, message: string): void;
}): void {
  if (input.repositories === undefined || input.repositories === null) {
    // Only stripped bootstraps (unit fixtures) omit the repository
    // container - the production bootstrap always supplies
    // storage.repositories (app/index.ts). Loud, never silent (review R4).
    input.warn(
      {},
      'Capability template approval-intent recovery is DISABLED: no repository container was supplied to this bootstrap.',
    );
    return;
  }
  const repository = capabilityTemplateApprovalIntentRepositoryFrom(
    input.repositories,
  );
  if (!repository) {
    // Fail CLOSED at startup: a real repository container WITHOUT the
    // intent consumer would let active host proposals record durable
    // targets nobody ever resumes (review R3).
    throw new Error(
      'Capability template approval-intent recovery repository is unavailable; refusing to start with active host proposals.',
    );
  }
  startCapabilityTemplateApprovalIntentRecoveryLoop({
    repository,
    claimerId: `runtime-capability-amendment:${process.pid}`,
    intervalMs: 5_000,
    recoverTarget: (target) => recoverTarget(input, target),
    warn: input.warn,
  });
}

async function recoverTarget(
  input: Parameters<
    typeof startRuntimeCapabilityTemplateApprovalIntentRecovery
  >[0],
  target: {
    appId: string;
    proposalId: string;
    capabilityId: string;
    jobId: string;
    expectedSetupFingerprint: string;
  },
): Promise<CapabilityTemplateApprovalTargetOutcome> {
  const job = await input.opsRepository.getJobById(target.jobId);
  const initial = classifyTarget(job, target);
  if (initial) return initial;
  // The recheck's conversationJid is a FILTER, not a requirement: a job
  // without a notification route still recovers (jobId-scoped), it just
  // sends no receipt (review R1/R2).
  const conversationJid = job!.execution_context?.conversationJid ?? '';
  const recovery = await recheckPausedSetupJobsAfterRequestAccessGrant({
    deps: {
      opsRepository: input.opsRepository,
      onSchedulerChanged: input.onSchedulerChanged,
      getToolRepository: input.getToolRepository,
      getSkillRepository: input.getSkillRepository,
      getMcpServerRepository: input.getMcpServerRepository,
      getCapabilitySecretRepository: input.getCapabilitySecretRepository,
      getCredentialBroker: input.getCredentialBroker,
      getBrowserStatus: input.getBrowserStatus,
      publishRuntimeEvent: input.publishRuntimeEvent,
      sendMessage: input.sendMessage,
    },
    appId: target.appId as never,
    sourceAgentFolder: job!.workspace_key,
    targetJid: conversationJid,
    jobId: target.jobId,
    recoveringPermissionRequestId: target.proposalId,
    logWarn: input.warn,
  });
  if (recovery?.queued.some((queued) => queued.jobId === target.jobId)) {
    return 'resumed';
  }
  return (
    classifyTarget(
      await input.opsRepository.getJobById(target.jobId),
      target,
    ) ?? 'retry'
  );
}

function classifyTarget(
  job: Awaited<ReturnType<IpcDeps['opsRepository']['getJobById']>>,
  target: {
    capabilityId: string;
    proposalId: string;
    expectedSetupFingerprint: string;
  },
): Exclude<CapabilityTemplateApprovalTargetOutcome, 'retry'> | undefined {
  if (!job) return 'superseded';
  // Only an ACTIVE job is resumed: ready-but-paused still needs the
  // resume transition, so it must stay pending for another pass (R2) -
  // and it must NOT be superseded either: readiness persisting 'ready'
  // (blockers cleared) right before a crash is exactly the state the
  // recheck below finishes (review R3).
  if (job.status === 'active') return 'resumed';
  if (
    job.status === 'paused' &&
    job.setup_state?.state === 'ready' &&
    job.pause_reason === SETUP_REQUIRED_PAUSE_REASON
  ) {
    // Only the crash-between-readiness-and-resume window: a job paused
    // for another reason falls through to the blocker check (review R9).
    // Deliberately NOT fingerprint-gated: resuming a setup-paused job
    // whose readiness is genuinely 'ready' is the desired end state for
    // EVERY path, so recovery finishing it is safe even if the context
    // that produced readiness was a different approval (review R12).
    return undefined;
  }
  // Only THIS intent's proposal keeps the target current - a blocker
  // replaced by a different proposal supersedes the old target (review R1).
  const blockerStillCurrent = job.setup_state?.blockers.some(
    (blocker) =>
      blocker.action.kind === 'fix_proposal' &&
      blocker.action.proposalId === target.proposalId,
  );
  return job.status === 'paused' &&
    job.setup_state?.fingerprint === target.expectedSetupFingerprint &&
    blockerStillCurrent
    ? undefined
    : 'superseded';
}
