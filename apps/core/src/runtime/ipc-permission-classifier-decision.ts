import { decisionForMode } from '../domain/permission-decision.js';
import type {
  ConversationRoute,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { resolveEffectivePermissionMode } from '../shared/permission-mode.js';
import {
  findConversationRouteForQueue,
  makeAgentThreadQueueKey,
} from '../shared/thread-queue-key.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type { IpcDeps } from './ipc-domain-types.js';
import {
  consultPermissionClassifierBeforePrompt,
  permissionPromotionHintCount,
  recordHumanPermissionPromotionSignal,
} from './permission-classifier.js';
import { runDurablePermissionInteraction } from '../application/interactions/durable-interaction-handler.js';

export async function resolvePermissionIpcDecision(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<PermissionApprovalDecision> {
  const route = input.request.targetJid
    ? findConversationRouteForQueue(
        input.deps.conversationRoutes?.() ?? {},
        makeAgentThreadQueueKey(
          input.request.targetJid,
          agentIdForFolder(input.sourceAgentFolder),
          input.request.threadId,
          input.request.providerAccountId,
        ),
        (candidate) => agentIdForFolder(candidate.folder),
      )
    : undefined;
  const settings = input.deps.getPermissionRuntimeSettings?.();
  const autoModeModel = settings?.permissions.autoMode.model;
  const classifierConfig = settings
    ? {
        ...(autoModeModel ? { autoModeModel } : {}),
        memoryExtractorModel: settings.memory.llm.models.extractor,
      }
    : undefined;
  const permissionMode = resolveEffectivePermissionMode(
    route?.folder === input.sourceAgentFolder
      ? route.agentConfig?.permissionMode
      : undefined,
    settings?.agents[input.sourceAgentFolder]?.permissionMode,
  );
  const promotionRepository = input.deps.getPermissionPromotionRepository?.();
  const promotion = promotionRepository
    ? {
        repository: promotionRepository,
        offer: async (request: PermissionApprovalRequest) => {
          const interaction = await runDurablePermissionInteraction({
            request,
            sourceAgentFolder: input.sourceAgentFolder,
            prompt: input.deps.requestPermissionApproval,
          });
          if (interaction.resolved)
            recordHumanPermissionPromotionSignal({
              repository: promotionRepository,
              appId: request.appId,
              agentFolder: input.sourceAgentFolder,
              request,
              decision: interaction.decision,
            });
          return interaction;
        },
      }
    : undefined;
  const trustedRequester = await isTrustedRequester(input, route);
  const classifierDecision =
    input.deps.publishRuntimeEvent && classifierConfig
      ? await consultPermissionClassifierBeforePrompt({
          permissionMode,
          trustedRequester,
          requestFamily: input.request.requestFamily ?? 'tool',
          appId: input.request.appId,
          agentId: input.request.agentId,
          agentFolder: input.sourceAgentFolder,
          runId: input.request.runId,
          jobId: input.request.jobId,
          conversationId: input.request.targetJid,
          threadId: input.request.threadId,
          correlationId: input.request.requestId,
          actor: 'permission',
          turnIntentSummary:
            input.request.turnIntentSummary ?? input.request.description ?? '',
          canonicalToolName: input.request.toolName,
          toolInput: input.request.toolInput,
          toolInputSanitized: input.request.toolInputSanitized,
          policyDecisionReason:
            input.request.decisionReason ?? 'Human approval is required.',
          suggestions: input.request.suggestions,
          ...(promotion ? { promotion } : {}),
          classifierConfig,
          publishRuntimeEvent: input.deps.publishRuntimeEvent,
          classifierConsult: input.deps.classifierConsult,
        })
      : undefined;

  if (classifierDecision?.decision === 'allow') {
    return decisionForMode(input.request, 'allow_once', 'auto_classifier');
  }
  if (permissionMode === 'auto' && input.request.unattended) {
    return {
      ...decisionForMode(input.request, 'cancel', 'runtime'),
      reason: classifierDecision
        ? `Classifier requested human approval: ${classifierDecision.reason}`
        : 'This tool is not eligible for unattended auto-permission.',
    };
  }
  input.request.promotionHintCount =
    classifierDecision?.promotionHintCount ??
    (await permissionPromotionHintCount({
      promotion,
      appId: input.request.appId,
      agentFolder: input.sourceAgentFolder,
      canonicalToolName: input.request.toolName,
      toolInput: input.request.toolInput,
      suggestions: input.request.suggestions,
    }));
  return input.deps.requestPermissionApproval(input.request);
}

async function isTrustedRequester(
  input: Parameters<typeof resolvePermissionIpcDecision>[0],
  route: ConversationRoute | undefined,
): Promise<boolean> {
  if (
    input.request.unattended &&
    input.request.jobId &&
    !input.request.senderId
  )
    return true;
  if (route?.conversationKind === 'dm') return true;
  if (
    route?.conversationKind !== 'channel' ||
    !input.request.targetJid ||
    !input.request.senderId ||
    !input.deps.isControlApproverAllowed
  ) {
    return false;
  }
  return input.deps
    .isControlApproverAllowed({
      conversationJid: input.request.targetJid,
      providerAccountId: input.request.providerAccountId,
      userId: input.request.senderId,
      sourceAgentFolder: input.sourceAgentFolder,
      decisionPolicy: 'same_channel',
    })
    .catch(() => false);
}
