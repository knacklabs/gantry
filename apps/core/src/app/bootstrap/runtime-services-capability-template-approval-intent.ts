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
  const repository = capabilityTemplateApprovalIntentRepositoryFrom(
    input.repositories,
  );
  if (!repository) return;
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
  const conversationJid = job!.execution_context?.conversationJid;
  if (!conversationJid) return 'superseded';
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
  target: { capabilityId: string; expectedSetupFingerprint: string },
): Exclude<CapabilityTemplateApprovalTargetOutcome, 'retry'> | undefined {
  if (!job) return 'superseded';
  if (job.status === 'active' || job.setup_state?.state === 'ready') {
    return 'resumed';
  }
  const blockerStillCurrent = job.setup_state?.blockers.some(
    (blocker) => blocker.action.kind === 'fix_proposal',
  );
  return job.status === 'paused' &&
    job.setup_state?.fingerprint === target.expectedSetupFingerprint &&
    blockerStillCurrent
    ? undefined
    : 'superseded';
}
