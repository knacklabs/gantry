import {
  bindPendingPermissionInteractionMessage,
  bindPendingQuestionInteractionCallback,
  DurableInteractionPersistenceError,
} from '../../application/interactions/pending-interaction-durability.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionCallbackScope,
} from '../../domain/types.js';
import type { UserQuestionRequest } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { permissionDecisionOptions } from '../permission-interaction.js';

type PendingTelegramPermission = {
  callback: {
    providerAlias: string;
    scope: PermissionCallbackScope;
    matchKind: 'individual' | 'batch';
  };
  sourceAgentFolder: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  approvalContextJid?: string;
  request: PermissionApprovalRequest;
  chatId: string;
  messageId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: PermissionApprovalDecision) => void;
};

export async function bindTelegramPermission(
  request: PermissionApprovalRequest,
  chatId: string,
  messageId: number | undefined,
  callbackId: string,
): Promise<boolean> {
  const bound = await bindPendingPermissionInteractionMessage({
    request,
    decisionOptions: permissionDecisionOptions(request),
    callbackId,
    ...(messageId === undefined
      ? {}
      : { externalMessageId: String(messageId) }),
    provider: 'telegram',
    conversationId: chatId,
  });
  return bound;
}

export async function registerAndBindTelegramPermissionPrompt(input: {
  jid: string;
  request: PermissionApprovalRequest;
  chatId: string;
  messageId: number;
  callback: PendingTelegramPermission['callback'];
  timeoutMs: number;
  pendingPrompts: Map<string, PendingTelegramPermission>;
  onTimeout: () => void;
  onPromptDelivered?: (messageId: string) => void;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<{ decision: Promise<PermissionApprovalDecision> }> {
  let resolveDecision!: (decision: PermissionApprovalDecision) => void;
  const decision = new Promise<PermissionApprovalDecision>((resolve) => {
    resolveDecision = resolve;
  });
  const timer = setTimeout(input.onTimeout, input.timeoutMs);
  const livePending = {
    callback: input.callback,
    sourceAgentFolder: input.request.sourceAgentFolder,
    decisionPolicy: input.request.decisionPolicy,
    approvalContextJid: input.request.approvalContextJid,
    request: input.request,
    chatId: input.chatId,
    messageId: input.messageId,
    timer,
    resolve: resolveDecision,
  };
  input.pendingPrompts.set(input.callback.providerAlias, livePending);
  try {
    const bound = await bindTelegramPermission(
      input.request,
      input.chatId,
      input.messageId,
      input.callback.providerAlias,
    );
    if (!bound) throw new Error('Telegram permission message binding failed');
  } catch (err) {
    if (err instanceof DurableInteractionPersistenceError) throw err;
    clearTimeout(timer);
    if (
      input.pendingPrompts.get(input.callback.providerAlias) === livePending
    ) {
      input.pendingPrompts.delete(input.callback.providerAlias);
    }
    resolveDecision({
      approved: false,
      reason: 'Failed to send approval prompt to Telegram',
    });
    logger.error(
      {
        jid: input.jid,
        requestId: input.request.requestId,
        error: input.sanitizeErrorMessage(err),
      },
      'Failed to send Telegram permission prompt',
    );
    return { decision };
  }
  input.onPromptDelivered?.(String(input.messageId));
  return { decision };
}

export async function bindTelegramQuestionCallback(
  request: UserQuestionRequest,
  callbackId: string,
  questionIndex: number,
): Promise<void> {
  const bound = await bindPendingQuestionInteractionCallback({
    sourceAgentFolder: request.sourceAgentFolder,
    requestId: request.requestId,
    callbackId,
    questionIndex,
    appId: request.appId,
  });
  if (!bound) throw new Error('Telegram user question callback binding failed');
}
