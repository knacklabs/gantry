import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  PermissionRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type {
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
} from '../../domain/types.js';
import type { IpcDeps } from '../../runtime/ipc-domain-types.js';
import {
  SETUP_REQUIRED_PAUSE_REASON,
  type JobReadinessBrowserStatus,
} from '../../application/jobs/job-readiness-service.js';
import { runDurablePermissionInteraction } from '../../application/interactions/durable-interaction-handler.js';
import { configurePendingInteractionPermissionPersistence } from '../../application/interactions/pending-interaction-durability.js';
import {
  configureSetupPausePermissionPrompt,
  setupPauseApproverRoute,
  setupPauseRequirementForApprovedSuggestions,
} from '../../application/jobs/setup-pause-permission-prompt.js';
import {
  requestPermissionReviewSuggestions,
  requestPermissionSetupDecisionOptions,
  resolveTrustedSemanticCapabilityDefinitions,
} from '../../jobs/request-permission-review.js';
import { resolveConversationRoute } from './runtime-app-routes.js';
import type { RuntimeApp } from './runtime-app.js';
import type { ChannelWiring } from './channel-wiring-types.js';
import { notifySchedulerPermissionRecovery } from '../../jobs/execution-notifications.js';
import { notifyJobSetupRequired } from '../../jobs/execution-readiness.js';

export function configureRuntimeSetupPausePermissions(input: {
  app: Pick<RuntimeApp, 'getConversationRoutes' | 'getCredentialBroker'>;
  channelWiring: Pick<
    ChannelWiring,
    | 'getRuntimeAppId'
    | 'requestPermissionApproval'
    | 'cancelPermissionApproval'
    | 'sendMessage'
  >;
  opsRepository: RuntimeJobRepository;
  getToolRepository: () => ToolCatalogRepository;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  getPermissionRepository?: () => PermissionRepository | undefined;
  mirrorAgentToolRulesToSettings: NonNullable<
    IpcDeps['mirrorAgentToolRulesToSettings']
  >;
  onSchedulerChanged(jobId?: string): void;
  getBrowserStatus(
    profileName: string,
  ): Promise<JobReadinessBrowserStatus | undefined>;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
}): void {
  configurePendingInteractionPermissionPersistence({
    opsRepository: input.opsRepository,
    // Revalidate before persistence, then declare the requirement only after
    // the durable grant has succeeded.
    beforePersistentGrant: (request, effectiveUpdates) =>
      setupPausePersistentGrantIsCurrent(
        input.opsRepository,
        request,
        effectiveUpdates,
      ),
    afterPersistentGrant: (request, effectiveUpdates) =>
      appendSetupPauseRequirementAfterPersistentGrant(
        input.opsRepository,
        request,
        effectiveUpdates,
      ),
    getToolRepository: input.getToolRepository,
    getPermissionRepository: input.getPermissionRepository,
    mirrorAgentToolRulesToSettings: input.mirrorAgentToolRulesToSettings,
    onSchedulerChanged: input.onSchedulerChanged,
    getSkillRepository: input.getSkillRepository,
    getMcpServerRepository: input.getMcpServerRepository,
    getCapabilitySecretRepository: input.getCapabilitySecretRepository,
    getCredentialBroker: input.app.getCredentialBroker,
    getBrowserStatus: input.getBrowserStatus,
    publishRuntimeEvent: input.publishRuntimeEvent,
    sendQueuedReceipt: (job, recoveryTransitionId) =>
      notifySchedulerPermissionRecovery({
        job,
        recoveryTransitionId,
        sendMessage: (jid, text, options) =>
          input.channelWiring.sendMessage(jid, text, {
            durability: 'required',
            throwOnMissing: true,
            ...(options ? { messageOptions: options } : {}),
          }),
      }),
    notifySetupRequired: ({ job, setupState, previousFingerprint }) =>
      notifyJobSetupRequired({
        currentJob: job,
        deps: {
          opsRepository: input.opsRepository,
          sendMessage: (jid, text, options) =>
            input.channelWiring.sendMessage(jid, text, {
              durability: 'required',
              throwOnMissing: true,
              ...(options ? { messageOptions: options } : {}),
            }),
        },
        runtimeAppId: String(input.channelWiring.getRuntimeAppId()),
        setupState,
        previousFingerprint,
        source: 'partial_recovery',
        publishRuntimeEvent:
          input.publishRuntimeEvent ?? (async () => undefined),
      }),
  });
  configureSetupPausePermissionPrompt({
    appId: String(input.channelWiring.getRuntimeAppId()),
    getJobById: async (jobId) =>
      (await input.opsRepository.getJobById(jobId)) ?? undefined,
    runPermissionInteraction: (
      request,
      onPromptDelivered,
      onInteractionBegan,
    ) =>
      runDurablePermissionInteraction({
        request,
        sourceAgentFolder: request.sourceAgentFolder,
        skipPromptWhenAlreadyPending: true,
        beforePrompt: onInteractionBegan,
        prompt: (durableRequest) =>
          input.channelWiring.requestPermissionApproval(
            durableRequest,
            onPromptDelivered,
          ),
      }),
    cancelPermissionApproval: input.channelWiring.cancelPermissionApproval,
    reviewStoredRequirement: async (review) => {
      const semanticCapabilityDefinitions =
        await resolveTrustedSemanticCapabilityDefinitions({
          deps: input,
          appId: review.appId as never,
          agentId: review.agentId as never,
        });
      const suggestions = requestPermissionReviewSuggestions(review.toolInput, {
        semanticCapabilityDefinitions,
      });
      return suggestions?.length
        ? {
            suggestions,
            decisionOptions: requestPermissionSetupDecisionOptions(
              review.toolInput,
              { semanticCapabilityDefinitions },
            ),
            ...(semanticCapabilityDefinitions
              ? { semanticCapabilityDefinitions }
              : {}),
          }
        : null;
    },
    resolveProviderAccountId: (job) => {
      const route = setupPauseApproverRoute(job);
      if (!route) return undefined;
      return resolveConversationRoute(
        input.app.getConversationRoutes(),
        route.conversationJid,
        route.threadId ?? undefined,
      )?.providerAccountId;
    },
  });
}

export async function setupPauseGrantIsCurrent(
  opsRepository: Pick<RuntimeJobRepository, 'getJobById'>,
  request: PermissionApprovalRequest,
): Promise<boolean> {
  if (!request.requestId.startsWith('setup-pause:')) return true;
  if (!request.jobId) return false;
  const job = await opsRepository.getJobById(request.jobId);
  // The shared persistence backend invokes this one setup-specific guard for
  // both live settlement and recovered durable decisions before grant apply.
  return job ? setupPauseGrantIsCurrentForJob(job, request) : false;
}

export async function setupPausePersistentGrantIsCurrent(
  opsRepository: Pick<RuntimeJobRepository, 'getJobById'>,
  request: PermissionApprovalRequest,
  effectiveUpdates: readonly PermissionApprovalUpdate[],
): Promise<boolean> {
  if (!request.requestId.startsWith('setup-pause:')) return true;
  if (!request.jobId) return false;
  const job = await opsRepository.getJobById(request.jobId);
  if (!job || !setupPauseGrantIsCurrentForJob(job, request)) return false;
  return setupPauseRequirementForApprovedSuggestions({
    job,
    suggestions: effectiveUpdates,
  }).matched;
}

export async function appendSetupPauseRequirementAfterPersistentGrant(
  opsRepository: Pick<
    RuntimeJobRepository,
    'getJobById' | 'appendJobAccessRequirement'
  >,
  request: PermissionApprovalRequest,
  effectiveUpdates: readonly PermissionApprovalUpdate[],
): Promise<boolean> {
  if (!request.requestId.startsWith('setup-pause:')) return true;
  if (!request.jobId) return false;
  for (
    let attempt = 0;
    attempt <= SETUP_REQUIREMENT_CAS_RETRY_LIMIT;
    attempt += 1
  ) {
    const job = await opsRepository.getJobById(request.jobId);
    if (!job || !setupPauseGrantIsCurrentForJob(job, request)) return false;
    const approved = setupPauseRequirementForApprovedSuggestions({
      job,
      suggestions: effectiveUpdates,
    });
    if (!approved.matched) return false;
    const requirements = approved.requirements ?? [];
    if (requirements.length === 0) return true;
    // Review R3: a multi-rule grant appends EVERY corresponding requirement -
    // appending only one would leave the declaration partial and re-strand
    // the job on its next run.
    let allAppended = true;
    let expectedUpdatedAt = job.updated_at;
    for (const requirement of requirements) {
      const appended = await opsRepository.appendJobAccessRequirement({
        jobId: job.id,
        requirement,
        expectedUpdatedAt,
      });
      if (!appended) {
        allAppended = false;
        break;
      }
      const refreshed = await opsRepository.getJobById(job.id);
      if (!refreshed) return false;
      expectedUpdatedAt = refreshed.updated_at;
    }
    if (allAppended) return true;
  }
  return false;
}

const SETUP_REQUIREMENT_CAS_RETRY_LIMIT = 1;

function setupPauseGrantIsCurrentForJob(
  job: NonNullable<Awaited<ReturnType<RuntimeJobRepository['getJobById']>>>,
  request: PermissionApprovalRequest,
): boolean {
  return Boolean(
    job.status === 'paused' &&
    job.pause_reason === SETUP_REQUIRED_PAUSE_REASON &&
    job.setup_state &&
    job.setup_state.state !== 'ready' &&
    request.requestId ===
      `setup-pause:${job.id}:${job.setup_state.fingerprint}`,
  );
}
