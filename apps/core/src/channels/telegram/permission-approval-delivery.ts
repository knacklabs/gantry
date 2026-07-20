import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionCallbackScope,
} from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { DurableInteractionPersistenceError } from '../../application/interactions/pending-interaction-durability.js';
import {
  TELEGRAM_USER_QUESTION_TIMEOUT_MS,
  telegramThreadOptionsFromString,
} from './channel-shared.js';
import {
  bindTelegramPermission,
  registerAndBindTelegramPermissionPrompt,
} from './prompt-binding.js';

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

export async function requestTelegramPermissionApproval(input: {
  interactionCallbacksEnabled: boolean;
  botConnected: boolean;
  jid: string;
  request: PermissionApprovalRequest;
  pendingPrompts: Map<string, PendingTelegramPermission>;
  sendPrompt: (input: {
    chatId: string;
    request: PermissionApprovalRequest;
    callbackId: string;
    timeoutMs: number;
    threadOpts: { message_thread_id?: number };
  }) => Promise<{ message_id: number }>;
  settlePrompt: (
    providerAlias: string,
    mode: NonNullable<PermissionApprovalDecision['mode']>,
    approverRef: string,
    reason: string,
  ) => Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
  onPromptDelivered?: (messageId: string) => void;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<PermissionApprovalDecision> {
  if (!input.interactionCallbacksEnabled) {
    return {
      approved: false,
      reason: 'This Telegram connection cannot collect approvals right now.',
    };
  }
  if (!input.botConnected) {
    return { approved: false, reason: 'Telegram bot is not connected' };
  }
  const chatId = input.jid.replace(/^tg:/, '');
  if (!chatId) {
    return {
      approved: false,
      reason: 'This Telegram conversation could not be identified.',
    };
  }
  if (
    [...input.pendingPrompts.values()].some(
      (pending) =>
        pending.callback.scope.appId === (input.request.appId || 'default') &&
        pending.callback.scope.sourceAgentFolder ===
          input.request.sourceAgentFolder &&
        pending.callback.scope.interactionId === input.request.requestId,
    )
  ) {
    return {
      approved: false,
      reason: 'This approval request is already awaiting a decision.',
    };
  }
  const callback = {
    providerAlias: globalThis.crypto.randomUUID(),
    scope: {
      appId: input.request.appId || 'default',
      sourceAgentFolder: input.request.sourceAgentFolder,
      interactionId: input.request.requestId,
    },
    matchKind: input.request.permissionBatch
      ? ('batch' as const)
      : ('individual' as const),
  };
  const timeoutMs = TELEGRAM_USER_QUESTION_TIMEOUT_MS;
  const timeoutPermissionPrompt = async (): Promise<void> => {
    let result = await input.settlePrompt(
      callback.providerAlias,
      'cancel',
      'system',
      'timed out',
    );
    if (result === 'settled') return;
    if (result === 'already_decided') return;
    if (result === 'retryable') {
      const firstDelay = Math.floor(timeoutMs / 3);
      for (const delayMs of [firstDelay, timeoutMs - firstDelay]) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
        if (!input.pendingPrompts.has(callback.providerAlias)) return;
        result = await input.settlePrompt(
          callback.providerAlias,
          'cancel',
          'system',
          'timed out',
        );
        if (result !== 'retryable') break;
      }
    }
    if (result === 'already_decided') return;
    const pending = input.pendingPrompts.get(callback.providerAlias);
    if (!pending) return;
    clearTimeout(pending.timer);
    input.pendingPrompts.delete(callback.providerAlias);
    pending.resolve({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'timed out',
    });
  };
  try {
    if (
      !(await bindTelegramPermission(
        input.request,
        chatId,
        undefined,
        callback.providerAlias,
      ))
    ) {
      throw new Error('Telegram permission callback binding failed');
    }
    const sent = await input.sendPrompt({
      chatId,
      request: input.request,
      callbackId: callback.providerAlias,
      timeoutMs,
      threadOpts: telegramThreadOptionsFromString(input.request.threadId),
    });
    const { decision } = await registerAndBindTelegramPermissionPrompt({
      jid: input.jid,
      request: input.request,
      chatId,
      messageId: sent.message_id,
      callback,
      timeoutMs,
      pendingPrompts: input.pendingPrompts,
      onTimeout: () => void timeoutPermissionPrompt(),
      onPromptDelivered: input.onPromptDelivered,
      sanitizeErrorMessage: input.sanitizeErrorMessage,
    });
    return await decision;
  } catch (err) {
    if (err instanceof DurableInteractionPersistenceError) throw err;
    logger.error(
      {
        jid: input.jid,
        requestId: input.request.requestId,
        error: input.sanitizeErrorMessage(err),
      },
      'Failed to send Telegram permission prompt',
    );
    return {
      approved: false,
      reason: 'Failed to send approval prompt to Telegram',
    };
  }
}
