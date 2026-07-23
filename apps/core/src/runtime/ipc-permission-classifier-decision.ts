import {
  decisionForMode,
  firstPersistentRule,
} from '../domain/permission-decision.js';
import type {
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
import type { ParsedPermissionIpcRequest } from './ipc-parsing.js';
import {
  consultPermissionClassifierBeforePrompt,
  permissionPromotionHintCount,
  recordHumanPermissionPromotionSignal,
} from './permission-classifier.js';
import { runDurablePermissionInteraction } from '../application/interactions/durable-interaction-handler.js';
import { resolveAgentToolRuntimePolicy } from '../application/agents/agent-tool-runtime-rules.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import type { YoloModeSettings } from '../shared/yolo-mode-policy.js';

export async function resolvePermissionIpcDecision(input: {
  request: ParsedPermissionIpcRequest;
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
  const approvedCapabilityIds =
    (
      settings?.agents[input.sourceAgentFolder] as
        | { capabilities?: Array<{ id: string }> }
        | null
        | undefined
    )?.capabilities?.map(({ id }) => id) ?? [];
  const autoModeModel = settings?.permissions.autoMode.model;
  const yoloMode = (
    settings?.permissions as { yoloMode?: YoloModeSettings } | undefined
  )?.yoloMode;
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
  const shouldConsultClassifier =
    input.deps.publishRuntimeEvent &&
    classifierConfig &&
    (permissionMode === 'auto' || permissionMode === 'auto_strict');
  const toolRepository = input.deps.getToolRepository?.();
  const reviewedMcpReadBindings =
    shouldConsultClassifier &&
    toolRepository &&
    /^mcp__(?!gantry__)/.test(input.request.toolName)
      ? ((
          await resolveAgentToolRuntimePolicy({
            repository: toolRepository,
            appId: input.request.appId ?? 'default',
            agentId:
              input.request.agentId ??
              agentIdForFolder(input.sourceAgentFolder),
            errorSubject: 'Configured agent tool',
            skillRepository: input.deps.getSkillRepository?.(),
          }).catch(() => undefined)
        )?.reviewedMcpReadBindings ?? [])
      : [];
  const classifierDecision = shouldConsultClassifier
    ? await consultPermissionClassifierBeforePrompt({
        permissionMode,
        requestFamily: input.request.requestFamily ?? 'tool',
        appId: input.request.appId,
        agentId: input.request.agentId,
        agentFolder: input.sourceAgentFolder,
        // Non-authoritative event metadata only — never a trust input.
        runId: input.request.runId,
        jobId: input.request.jobId,
        conversationId: input.request.targetJid,
        threadId: input.request.threadId,
        correlationId: input.request.requestId,
        actor: 'permission',
        // Host-injected at spawn; best-effort context for the classifier to
        // narrow with — never a trust input.
        intentSource: input.request.turnIntentSummary
          ? 'runner_summary'
          : 'none',
        turnIntentSummary: input.request.turnIntentSummary ?? '',
        canonicalToolName: input.request.toolName,
        toolInput: input.request.classifierToolInput ?? input.request.toolInput,
        toolInputRedactedPaths: input.request.toolInputRedactedPaths,
        toolInputTruncatedPaths: input.request.toolInputTruncatedPaths,
        policyDecisionReason:
          input.request.decisionReason ?? 'Human approval is required.',
        approvedCapabilityIds,
        workspaceRoot: resolveWorkspaceFolderPath(input.sourceAgentFolder),
        reviewedMcpReadBindings,
        yoloMode,
        suggestions: input.request.suggestions,
        ...(promotion ? { promotion } : {}),
        classifierConfig: classifierConfig!,
        publishRuntimeEvent: input.deps.publishRuntimeEvent!,
        classifierConsult: input.deps.classifierConsult,
      })
    : undefined;

  if (classifierDecision?.decision === 'allow') {
    return decisionForMode(input.request, 'allow_once', 'auto_classifier');
  }
  if (
    (permissionMode === 'auto' || permissionMode === 'auto_strict') &&
    input.request.unattended
  ) {
    return {
      ...decisionForMode(input.request, 'cancel', 'runtime'),
      reason: classifierDecision
        ? `Classifier requested human approval: ${classifierDecision.reason}`
        : 'This tool is not eligible for unattended auto-permission.',
    };
  }
  if (classifierDecision?.denylistHit) {
    // Denylist-forced prompts are allow-once/cancel only: a persisted rule
    // would never be honored while the denylist blocks rule-based auto-allows.
    input.request.suggestions = undefined;
    input.request.decisionOptions = ['allow_once', 'cancel'];
    return input.deps.requestPermissionApproval(input.request);
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
  const effectiveDecisionOptions = input.request.decisionOptions?.length
    ? input.request.decisionOptions
    : firstPersistentRule(input.request)
      ? ['allow_once', 'allow_persistent_rule', 'cancel']
      : ['allow_once', 'cancel'];
  if (
    input.request.promotionHintCount &&
    effectiveDecisionOptions.includes('allow_persistent_rule')
  ) {
    input.request.decisionOptions = [
      'allow_persistent_rule',
      'allow_once',
      'cancel',
    ];
  }
  return input.deps.requestPermissionApproval(input.request);
}
