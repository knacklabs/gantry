import type { Api } from 'grammy';
import {
  claimPermissionInteractionCallback,
  releasePermissionInteractionCallback,
} from '../../application/interactions/pending-interaction-durability.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionCallbackScope,
} from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  decisionForMode,
  formatPermissionReceiptText,
} from '../permission-interaction.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';
import { escapeTelegramHtml } from './html-render.js';

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

export async function claimAndSettleTelegramPermissionPrompt(input: {
  providerAlias: string;
  mode: NonNullable<PermissionApprovalDecision['mode']>;
  approverRef: string;
  reason: string;
  pendingPrompts: Map<string, PendingTelegramPermission>;
  api: Api | null;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'> {
  const pending = input.pendingPrompts.get(input.providerAlias);
  if (!pending) return 'already_decided';
  const claimed = await claimPermissionInteractionCallback({
    scope: pending.callback.scope,
    mode: input.mode,
    approverRef: input.approverRef,
    matchKind: pending.callback.matchKind,
    providerAlias: input.providerAlias,
  });
  if (claimed.status === 'already_decided')
    return claimed.ownerless ? 'ownerless' : 'already_decided';
  if (claimed.status === 'retryable') return 'retryable';
  const decision = {
    ...decisionForMode(pending.request, input.mode, input.approverRef),
    reason: input.reason,
    permissionCallbackClaim: claimed.claim,
  };
  if (await settleTelegramPermissionPrompt(input, decision)) return 'settled';
  await releasePermissionInteractionCallback({ claim: claimed.claim });
  return 'retryable';
}

async function settleTelegramPermissionPrompt(
  input: Pick<
    Parameters<typeof claimAndSettleTelegramPermissionPrompt>[0],
    'providerAlias' | 'pendingPrompts' | 'api' | 'sanitizeErrorMessage'
  >,
  decision: PermissionApprovalDecision,
): Promise<boolean> {
  const pending = input.pendingPrompts.get(input.providerAlias);
  if (!pending || !input.api) return false;
  const requestId = pending.request.requestId;
  const receipt = formatPermissionReceiptText(
    requestId,
    pending.request,
    decision,
  );
  let deleted = false;
  if (decision.approved && decision.mode !== 'cancel') {
    try {
      await input.api.deleteMessage(pending.chatId, pending.messageId);
      deleted = true;
    } catch (err) {
      logger.debug(
        { requestId, err: input.sanitizeErrorMessage(err) },
        'Failed to delete approved Telegram permission prompt; editing fallback receipt',
      );
    }
  }
  const text = escapeTelegramHtml(receipt);
  if (!deleted) {
    try {
      await input.api.editMessageText(pending.chatId, pending.messageId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      logger.debug(
        { requestId, err: input.sanitizeErrorMessage(err) },
        'Failed to update Telegram permission prompt message',
      );
      try {
        await input.api.sendMessage(pending.chatId, text, {
          parse_mode: 'HTML',
          ...telegramThreadOptionsFromString(pending.request.threadId),
        });
      } catch (sendErr) {
        logger.debug(
          { requestId, err: input.sanitizeErrorMessage(sendErr) },
          'Failed to send Telegram permission receipt fallback',
        );
        return false;
      }
    }
  }
  clearTimeout(pending.timer);
  input.pendingPrompts.delete(input.providerAlias);
  pending.resolve(decision);
  return true;
}
