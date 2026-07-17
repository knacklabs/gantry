import {
  claimPermissionInteractionCallback,
  findDurablePermissionInteractionByPromptMessage,
  findDurablePermissionInteractionByRequestId,
  releasePermissionInteractionCallback,
  resolveDurablePermissionInteractionByRequestId,
  type DurablePermissionInteractionContext,
} from '../../application/interactions/pending-interaction-durability.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
} from '../../domain/types.js';
import {
  decisionForMode,
  formatPermissionReceiptText,
} from '../permission-interaction.js';
import { escapeTelegramHtml } from './html-render.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';

interface TelegramPermissionCallbackContext {
  callbackQuery?: {
    from?: {
      id?: number | string;
      first_name?: string;
      username?: string;
    };
    message?: {
      message_id?: number;
      message_thread_id?: number;
      chat?: { id?: number | string };
    };
  };
  chat?: { id?: number | string };
  from?: {
    id?: number | string;
    first_name?: string;
    username?: string;
  };
  api: {
    deleteMessage(chatId: string, messageId: number): Promise<unknown>;
    editMessageText(
      chatId: string,
      messageId: number,
      text: string,
      options: Record<string, unknown>,
    ): Promise<unknown>;
    sendMessage(
      chatId: string,
      text: string,
      options: Record<string, unknown>,
    ): Promise<unknown>;
  };
  answerCallbackQuery: (input: {
    text: string;
    show_alert: boolean;
  }) => Promise<unknown>;
}

export async function resolveDurableTelegramPermissionCallback(input: {
  context: TelegramPermissionCallbackContext;
  appId: string;
  providerAlias: string;
  mode: PermissionApprovalDecisionMode;
  sanitizeErrorMessage: (err: unknown) => string;
  isAuthorized: (
    approvalContextJid: string,
    userId: string,
    durable: DurablePermissionInteractionContext,
  ) => Promise<boolean>;
}): Promise<void> {
  const callbackQuery = input.context.callbackQuery;
  const message = callbackQuery?.message;
  const callbackChatId =
    message?.chat?.id?.toString() || input.context.chat?.id?.toString() || '';
  const messageId = message?.message_id;
  const userId =
    callbackQuery?.from?.id?.toString() ||
    input.context.from?.id?.toString() ||
    '';
  if (!callbackChatId || messageId === undefined || !userId) {
    await inactive(input.context);
    return;
  }
  const promptIdentity = {
    appId: input.appId,
    provider: 'telegram',
    conversationId: callbackChatId,
    externalMessageId: String(messageId),
    ...(message?.message_thread_id === undefined
      ? {}
      : { threadId: String(message.message_thread_id) }),
  };
  const activePrompt = await findDurablePermissionInteractionByPromptMessage({
    ...promptIdentity,
    providerAlias: input.providerAlias,
  });
  const prompt =
    activePrompt ??
    (await findDurablePermissionInteractionByPromptMessage(promptIdentity));
  if (
    !prompt ||
    (!activePrompt &&
      (!prompt.claim ||
        !prompt.claim.match.providerAliases.includes(input.providerAlias)))
  ) {
    await inactive(input.context);
    return;
  }
  const durable = await findDurablePermissionInteractionByRequestId({
    scope: prompt.scope,
  });
  const authorized =
    durable?.targetJid === `tg:${callbackChatId}` &&
    Boolean(durable.approvalContextJid) &&
    (await input.isAuthorized(durable.approvalContextJid!, userId, durable));
  const matchKind = prompt.claim?.match.kind ?? prompt.matchKind;
  if (
    !authorized ||
    !durable ||
    !durable.decisionOptions.includes(input.mode)
  ) {
    await inactive(input.context);
    return;
  }
  const claimed = prompt.claim
    ? { status: 'claimed' as const, claim: prompt.claim }
    : await claimPermissionInteractionCallback({
        scope: prompt.scope,
        mode: input.mode,
        approverRef: userId,
        matchKind,
        providerAlias: input.providerAlias,
      });
  if (claimed.status === 'already_decided') {
    await input.context.answerCallbackQuery({
      text: 'Permission request was already decided.',
      show_alert: true,
    });
    return;
  }
  if (claimed.status === 'retryable') {
    await input.context.answerCallbackQuery({
      text: 'Could not record the decision. Please retry.',
      show_alert: true,
    });
    return;
  }
  const decision = recoveredTelegramPermissionDecision(
    durable.request,
    prompt.claim,
    input.mode,
    userId,
    claimed.claim,
    matchKind,
  );
  if (
    !(await terminalizeTelegramPermissionPrompt({
      context: input.context,
      chatId: callbackChatId,
      messageId,
      request: durable.request,
      threadId: durable.threadId ?? undefined,
      decision,
      sanitizeErrorMessage: input.sanitizeErrorMessage,
    }))
  ) {
    await releasePermissionInteractionCallback({ claim: claimed.claim });
    await input.context.answerCallbackQuery({
      text: 'Could not record the decision. Please retry.',
      show_alert: true,
    });
    return;
  }
  const resolved = await resolveDurablePermissionInteractionByRequestId({
    claim: claimed.claim,
    reason: 'resolved via Telegram after channel restart',
  });
  await input.context.answerCallbackQuery({
    text: resolved
      ? 'Decision recorded. Details will update in chat.'
      : 'Permission request is no longer active.',
    show_alert: !resolved,
  });
}

async function terminalizeTelegramPermissionPrompt(input: {
  context: TelegramPermissionCallbackContext;
  chatId: string;
  messageId: number;
  request: PermissionApprovalRequest | null;
  threadId?: string;
  decision: PermissionApprovalDecision;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<boolean> {
  const approved = input.decision.approved && input.decision.mode !== 'cancel';
  if (approved) {
    try {
      await input.context.api.deleteMessage(input.chatId, input.messageId);
      return true;
    } catch {
      // Fall through to the visible receipt replacement.
    }
  }
  const text = escapeTelegramHtml(
    input.request
      ? formatPermissionReceiptText(
          input.request.requestId,
          input.request,
          input.decision,
        )
      : approved
        ? 'Permission allowed.'
        : 'Permission request denied.',
  );
  try {
    await input.context.api.editMessageText(
      input.chatId,
      input.messageId,
      text,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      },
    );
    return true;
  } catch {
    try {
      await input.context.api.sendMessage(input.chatId, text, {
        parse_mode: 'HTML',
        ...telegramThreadOptionsFromString(input.threadId),
      });
      return true;
    } catch (err) {
      input.sanitizeErrorMessage(err);
      return false;
    }
  }
}

function recoveredTelegramPermissionDecision(
  request: PermissionApprovalRequest | null,
  persistedClaim: PermissionCallbackClaim | undefined,
  incomingMode: PermissionApprovalDecisionMode,
  incomingApprover: string,
  claim: PermissionCallbackClaimReference,
  matchKind: PermissionCallbackClaim['match']['kind'],
): PermissionApprovalDecision {
  const mode = persistedClaim?.intent.mode ?? incomingMode;
  const approverRef = persistedClaim?.intent.approverRef ?? incomingApprover;
  const decision = request
    ? decisionForMode(request, mode, approverRef, matchKind)
    : { approved: mode !== 'cancel', mode, decidedBy: approverRef };
  return { ...decision, permissionCallbackClaim: claim };
}

async function inactive(
  context: TelegramPermissionCallbackContext,
): Promise<void> {
  await context.answerCallbackQuery({
    text: 'Permission request is no longer active.',
    show_alert: true,
  });
}
