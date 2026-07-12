import { decisionForMode } from '../domain/permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { resolveEffectivePermissionMode } from '../shared/permission-mode.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { consultPermissionClassifierBeforePrompt } from './permission-classifier.js';

export async function resolvePermissionIpcDecision(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<PermissionApprovalDecision> {
  const route = input.request.targetJid
    ? input.deps.conversationRoutes?.()[input.request.targetJid]
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
  const classifierDecision =
    input.deps.publishRuntimeEvent && classifierConfig
      ? await consultPermissionClassifierBeforePrompt({
          permissionMode,
          requestFamily: 'tool',
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
          policyDecisionReason:
            input.request.decisionReason ?? 'Human approval is required.',
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
  return input.deps.requestPermissionApproval(input.request);
}
