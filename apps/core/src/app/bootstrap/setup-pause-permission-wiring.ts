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
import type { PermissionApprovalRequest } from '../../domain/types.js';
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
    // The shared durable path runs this setup-specific guard for both live
    // settlement and restart recovery immediately before grant persistence.
    beforePersistentGrant: (request) =>
      setupPauseGrantIsCurrent(input.opsRepository, request),
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
  return Boolean(
    job &&
    job.status === 'paused' &&
    job.pause_reason === SETUP_REQUIRED_PAUSE_REASON &&
    job.setup_state &&
    job.setup_state.state !== 'ready' &&
    request.requestId ===
      `setup-pause:${job.id}:${job.setup_state.fingerprint}`,
  );
}
