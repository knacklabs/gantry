import type { AppId } from '../domain/app/app.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { recheckSetupPausedJobsAfterCapabilityUpdate } from '../application/jobs/job-permission-recovery.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import { formatDurableAccessRulesForUser } from './request-permission-review.js';
import { notifySchedulerPermissionRecovery } from './execution-notifications.js';
import { notifyJobSetupRequired } from './execution-readiness.js';

type RequestAccessRecoveryResult = Awaited<
  ReturnType<typeof recheckSetupPausedJobsAfterCapabilityUpdate>
>;

export async function recheckPausedSetupJobsAfterRequestAccessGrant(input: {
  deps: IpcDeps;
  appId: AppId;
  sourceAgentFolder: string;
  targetJid: string;
  jobId?: string;
  recoveringPermissionRequestId: string;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
}): Promise<RequestAccessRecoveryResult | undefined> {
  const opsRepository = input.deps.opsRepository;
  if (!opsRepository) return undefined;
  if (input.jobId && typeof opsRepository.getJobById !== 'function') {
    return undefined;
  }
  if (!input.jobId && typeof opsRepository.listJobs !== 'function') {
    return undefined;
  }
  try {
    return await recheckSetupPausedJobsAfterCapabilityUpdate({
      appId: input.appId,
      sourceAgentFolder: input.sourceAgentFolder,
      conversationJid: input.targetJid,
      jobId: input.jobId,
      recoveringPermissionRequestId: input.recoveringPermissionRequestId,
      opsRepository,
      scheduler: {
        requestSchedulerSync: input.deps.onSchedulerChanged,
      },
      toolRepository: input.deps.getToolRepository?.(),
      skillRepository: input.deps.getSkillRepository?.(),
      mcpServerRepository: input.deps.getMcpServerRepository?.(),
      capabilitySecretRepository: input.deps.getCapabilitySecretRepository?.(),
      credentialBroker: await input.deps.getCredentialBroker?.(),
      getBrowserStatus: input.deps.getBrowserStatus,
      publishRuntimeEvent: input.deps.publishRuntimeEvent,
      sendQueuedReceipt: (job, recoveryTransitionId) =>
        notifySchedulerPermissionRecovery({
          job,
          recoveryTransitionId,
          sendMessage: input.deps.sendMessage,
        }),
      notifySetupRequired: ({ job, setupState, previousFingerprint }) =>
        notifyJobSetupRequired({
          currentJob: job,
          deps: input.deps,
          runtimeAppId: input.appId,
          setupState,
          previousFingerprint,
          source: 'partial_recovery',
          publishRuntimeEvent:
            input.deps.publishRuntimeEvent ?? (async () => undefined),
        }),
    });
  } catch (err) {
    input.logWarn?.(
      { err, sourceAgentFolder: input.sourceAgentFolder, jobId: input.jobId },
      'Failed to recheck setup-paused jobs after access grant',
    );
    return undefined;
  }
}

export function formatRequestAccessPersistentGrantMessage(input: {
  displayName: string;
  rules: string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  recovery?: RequestAccessRecoveryResult;
}): string {
  const lines = [
    `Allowed ${input.displayName}. Future matching requests are allowed. Details: ${formatDurableAccessRulesForUser(input.rules, { semanticCapabilityDefinitions: input.semanticCapabilityDefinitions })}.`,
  ];
  if (input.recovery?.queued.length) {
    lines.push(
      `Job resumed: ${input.recovery.queued
        .map((job) => job.name || job.jobId)
        .join(', ')}.`,
    );
  }
  if (input.recovery?.stillBlocked.length) {
    const blocker = input.recovery.stillBlocked[0];
    lines.push(
      `Job still needs setup: ${blocker.nextAction ?? 'review job setup'}.`,
    );
  }
  return lines.join('\n');
}
