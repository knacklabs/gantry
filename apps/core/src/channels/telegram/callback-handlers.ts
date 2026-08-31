import { resolveDurableQuestionInteractionByRequestId } from '../../application/interactions/pending-interaction-durability.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { ChannelOpts } from '../channel-provider.js';
import { withObserverDigestEditLock } from '../observer-digest-edit-lock.js';
import {
  normalizePermissionAction,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import type { PendingPermission } from './channel-permission-cancellation.js';
import {
  TELEGRAM_BRAIN_REVIEW_CALLBACK_PATTERN,
  TELEGRAM_BRAIN_REVIEW_DECISION_BY_CODE,
  TELEGRAM_REVIEW_CALLBACK_PATTERN,
  TELEGRAM_REVIEW_DECISION_BY_CODE,
} from './message-action-affordances.js';
import {
  parseTelegramObserverCallback,
  telegramObserverDigestMessage,
  truncateTelegramCallbackAnswer,
} from './observer-digest-message.js';
import { resolveDurableTelegramPermissionCallback } from './permission-callback.js';
import { handleTelegramSchedulerCallback } from './scheduler-callback.js';
import {
  TELEGRAM_DEAD_LETTER_ACTION_CALLBACK_PATTERN,
  TELEGRAM_PERMISSION_CALLBACK_PATTERN,
  TELEGRAM_USER_QUESTION_CALLBACK_PATTERN,
  type PendingUserQuestionState,
  type TelegramUserQuestionCallbackTarget,
} from './channel-shared.js';

export interface TelegramCallbackContext {
  raw: TelegramCallbackRawContext;
  data: string;
  callbackQueryId?: string;
  messageId?: string;
  chatId: string;
  conversationJid?: string;
  threadId?: string;
  userId?: string;
  providerAccountId?: string;
  answer: (text?: string, showAlert?: boolean) => Promise<unknown>;
}

interface TelegramCallbackRawContext {
  callbackQuery?: {
    id?: string;
    data?: unknown;
    from?: {
      id?: number | string;
      first_name?: string;
      username?: string;
    };
    message?: {
      chat?: { id?: number | string };
      message_id?: number;
      message_thread_id?: number;
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
      options?: Record<string, unknown>,
    ): Promise<{ message_id: number }>;
  };
  answerCallbackQuery: (input?: {
    text?: string;
    show_alert?: boolean;
  }) => Promise<unknown>;
  editMessageText(
    text: string,
    options: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface TelegramCallbackChannel {
  opts: Pick<ChannelOpts, 'appId' | 'providerAccountId' | 'onMessageAction'>;
  pendingPermissionPrompts: Map<string, PendingPermission>;
  pendingUserQuestionCallbackIds: Map<
    string,
    TelegramUserQuestionCallbackTarget
  >;
  pendingUserQuestions: Map<string, PendingUserQuestionState>;
  pendingUserQuestionOtherPrompts: Map<
    string,
    TelegramUserQuestionCallbackTarget
  >;
  pendingUserQuestionKey: (
    appId: string,
    sourceAgentFolder: string,
    requestId: string,
    questionIndex: number,
  ) => string;
  isTelegramApproverAuthorized: (
    chatId: string,
    userId: string,
    sourceAgentFolder: string,
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'],
    threadId?: string,
  ) => Promise<boolean>;
  finalizeUserQuestionPrompt: (
    pending: PendingUserQuestionState,
    selection: string | string[],
    answeredBy?: string,
    reason?: string,
  ) => Promise<void>;
  refreshUserQuestionPrompt: (
    pending: PendingUserQuestionState,
  ) => Promise<void>;
  claimAndResolvePermissionPrompt: (
    providerAlias: string,
    mode: NonNullable<PermissionApprovalDecision['mode']>,
    approverRef: string,
    reason: string,
  ) => Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
  sanitizeErrorMessage: (err: unknown) => string;
}

type TelegramUserQuestionMatch = RegExpExecArray;
type TelegramReviewMatch = RegExpExecArray;
type TelegramObserverCallback = NonNullable<
  ReturnType<typeof parseTelegramObserverCallback>
>;

export function createTelegramCallbackContext(input: {
  raw: TelegramCallbackRawContext;
  data: string;
  providerAccountId?: string;
}): TelegramCallbackContext {
  const callbackMessage = input.raw.callbackQuery?.message as
    | {
        chat?: { id?: number | string };
        message_id?: number;
        message_thread_id?: number;
      }
    | undefined;
  const chatId =
    callbackMessage?.chat?.id?.toString() ||
    input.raw.chat?.id?.toString() ||
    '';
  const threadId =
    typeof callbackMessage?.message_thread_id === 'number'
      ? String(callbackMessage.message_thread_id)
      : undefined;
  const messageId =
    typeof callbackMessage?.message_id === 'number'
      ? String(callbackMessage.message_id)
      : undefined;
  const callbackQueryId =
    typeof input.raw.callbackQuery?.id === 'string'
      ? input.raw.callbackQuery.id
      : undefined;

  return {
    raw: input.raw,
    data: input.data,
    callbackQueryId,
    messageId,
    chatId,
    conversationJid: chatId ? `tg:${chatId}` : undefined,
    threadId,
    userId: input.raw.from?.id?.toString(),
    providerAccountId: input.providerAccountId,
    answer: (text, showAlert) =>
      text === undefined
        ? input.raw.answerCallbackQuery()
        : input.raw.answerCallbackQuery({
            text,
            ...(showAlert ? { show_alert: true } : {}),
          }),
  };
}

export async function dispatchTelegramCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
): Promise<void> {
  const userQuestionMatch = TELEGRAM_USER_QUESTION_CALLBACK_PATTERN.exec(
    ctx.data,
  );
  if (userQuestionMatch) {
    await handleTelegramUserQuestionCallback(channel, ctx, userQuestionMatch);
    return;
  }
  if (ctx.data.startsWith('lt:stop:')) {
    await handleTelegramLiveTurnStopCallback(channel, ctx);
    return;
  }
  if (ctx.data.startsWith('jp:')) {
    await handleTelegramJobPermissionCallback(channel, ctx);
    return;
  }
  const reviewMatch = TELEGRAM_REVIEW_CALLBACK_PATTERN.exec(ctx.data);
  if (reviewMatch) {
    await handleTelegramMemoryReviewCallback(channel, ctx, reviewMatch);
    return;
  }
  const brainReviewMatch = TELEGRAM_BRAIN_REVIEW_CALLBACK_PATTERN.exec(
    ctx.data,
  );
  if (brainReviewMatch) {
    await handleTelegramBrainReviewCallback(channel, ctx, brainReviewMatch);
    return;
  }
  const observer = parseTelegramObserverCallback({
    data: ctx.data,
    callbackMessage: ctx.raw.callbackQuery?.message,
    fallbackChatId: ctx.raw.chat?.id,
  });
  if (observer) {
    await handleTelegramObserverCallback(channel, ctx, observer);
    return;
  }
  const compactRetryJobId = ctx.data.startsWith('r:') ? ctx.data.slice(2) : '';
  const askRetryJobId = ctx.data.startsWith('a:') ? ctx.data.slice(2) : '';
  const deadLetterActionMatch =
    compactRetryJobId || askRetryJobId
      ? null
      : TELEGRAM_DEAD_LETTER_ACTION_CALLBACK_PATTERN.exec(ctx.data);
  if (compactRetryJobId || askRetryJobId || deadLetterActionMatch) {
    await handleTelegramSchedulerCallback(
      channel,
      ctx,
      compactRetryJobId,
      deadLetterActionMatch,
      askRetryJobId,
    );
    return;
  }
  await handleTelegramPermissionCallback(channel, ctx);
}

async function handleTelegramUserQuestionCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  userQuestionMatch: TelegramUserQuestionMatch,
): Promise<void> {
  const action = userQuestionMatch[1] as 'select' | 'done' | 'other';
  const callbackId = userQuestionMatch[2];
  const callbackTarget = channel.pendingUserQuestionCallbackIds.get(callbackId);
  if (!callbackTarget) {
    await ctx.answer('Question is no longer active.', true);
    return;
  }
  const requestId = callbackTarget.requestId;
  const questionIndex = callbackTarget.questionIndex;
  const optionIndex = userQuestionMatch[3]
    ? Number.parseInt(userQuestionMatch[3], 10)
    : undefined;
  if (!Number.isInteger(questionIndex)) return;
  const key = channel.pendingUserQuestionKey(
    callbackTarget.appId,
    callbackTarget.sourceAgentFolder,
    requestId,
    questionIndex,
  );
  const pending = channel.pendingUserQuestions.get(key);
  if (!pending) {
    await ctx.answer('Question is no longer active.', true);
    return;
  }
  const callbackChatId = ctx.raw.chat?.id?.toString() || '';
  if (!callbackChatId || callbackChatId !== pending.chatId) {
    await ctx.answer('This question belongs to a different chat.', true);
    return;
  }
  const userId = ctx.userId || '';
  if (!userId) {
    await ctx.answer('Unable to verify responder identity.', true);
    return;
  }
  const authorized = await channel.isTelegramApproverAuthorized(
    pending.chatId,
    userId,
    pending.sourceAgentFolder,
  );
  if (!authorized) {
    await ctx.answer('Only a conversation control approver can answer.', true);
    return;
  }
  if (action === 'other') {
    await handleTelegramOtherUserQuestionCallback(
      channel,
      ctx,
      pending,
      requestId,
      questionIndex,
    );
    return;
  }
  const answeredBy =
    ctx.raw.from?.first_name || ctx.raw.from?.username || userId || 'unknown';
  if (action === 'done') {
    await handleTelegramDoneUserQuestionCallback(
      channel,
      ctx,
      pending,
      answeredBy,
    );
    return;
  }
  await handleTelegramOptionUserQuestionCallback(
    channel,
    ctx,
    pending,
    requestId,
    questionIndex,
    optionIndex,
    answeredBy,
  );
}

async function handleTelegramOtherUserQuestionCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  pending: PendingUserQuestionState,
  requestId: string,
  questionIndex: number,
): Promise<void> {
  const threadId = (
    ctx.raw.callbackQuery?.message as { message_thread_id?: number } | undefined
  )?.message_thread_id;
  let promptMessageId: number | undefined;
  try {
    const prompt = await ctx.raw.api.sendMessage(
      pending.chatId,
      'Reply to this message with your answer.',
      {
        ...(typeof threadId === 'number'
          ? { message_thread_id: threadId }
          : {}),
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Type your answer…',
        },
      },
    );
    promptMessageId = prompt.message_id;
  } catch (err) {
    logger.debug(
      { requestId, err: channel.sanitizeErrorMessage(err) },
      'Failed to send Telegram Other free-text prompt',
    );
  }
  if (promptMessageId === undefined) {
    await ctx.answer('Could not start a free-text reply.', true);
    return;
  }
  channel.pendingUserQuestionOtherPrompts.set(
    `${pending.chatId}:${promptMessageId}`,
    {
      appId: pending.appId,
      sourceAgentFolder: pending.sourceAgentFolder,
      requestId,
      questionIndex,
    },
  );
  await ctx.answer('Reply with your answer.');
}

async function handleTelegramDoneUserQuestionCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  pending: PendingUserQuestionState,
  answeredBy: string,
): Promise<void> {
  if (!pending.multiSelect) {
    await ctx.answer('This question expects a single selection.', true);
    return;
  }
  const selectedLabels = [...pending.selectedOptionIndexes]
    .sort((a, b) => a - b)
    .map((index) => pending.optionLabels[index])
    .filter(Boolean);
  await channel.finalizeUserQuestionPrompt(
    pending,
    selectedLabels,
    answeredBy,
    'answered via Telegram',
  );
  await ctx.answer('Saved.');
}

async function handleTelegramOptionUserQuestionCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  pending: PendingUserQuestionState,
  requestId: string,
  questionIndex: number,
  optionIndex: number | undefined,
  answeredBy: string,
): Promise<void> {
  if (
    optionIndex === undefined ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= pending.optionLabels.length
  ) {
    await ctx.answer('Invalid option.', true);
    return;
  }
  if (pending.multiSelect) {
    const persisted = await resolveDurableQuestionInteractionByRequestId({
      requestId,
      appId: pending.appId,
      sourceAgentFolder: pending.sourceAgentFolder,
      questionIndex,
      optionIndex,
      finalize: false,
    });
    if (!persisted) {
      await ctx.answer('Question is no longer active.', true);
      return;
    }
    if (pending.selectedOptionIndexes.has(optionIndex)) {
      pending.selectedOptionIndexes.delete(optionIndex);
    } else {
      pending.selectedOptionIndexes.add(optionIndex);
    }
    await channel.refreshUserQuestionPrompt(pending);
    await ctx.answer('Selection updated.');
    return;
  }
  const selected = pending.optionLabels[optionIndex];
  await channel.finalizeUserQuestionPrompt(
    pending,
    selected,
    answeredBy,
    'answered via Telegram',
  );
  await ctx.answer('Saved.');
}

async function handleTelegramLiveTurnStopCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
): Promise<void> {
  if (!ctx.conversationJid) return;
  await channel.opts.onMessageAction?.({
    kind: 'live_turn_stop',
    conversationJid: ctx.conversationJid,
    ...(ctx.providerAccountId
      ? { providerAccountId: ctx.providerAccountId }
      : {}),
    threadId: ctx.threadId,
    userId: ctx.userId,
    actionToken: ctx.data.slice('lt:stop:'.length),
  });
  await ctx.answer('Stopping current run.');
}

async function handleTelegramJobPermissionCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
): Promise<void> {
  if (!ctx.conversationJid) return;
  await channel.opts.onMessageAction?.({
    kind: 'job_permission_decision',
    conversationJid: ctx.conversationJid,
    ...(ctx.providerAccountId
      ? { providerAccountId: ctx.providerAccountId }
      : {}),
    threadId: ctx.threadId,
    userId: ctx.userId,
    ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
    actionToken: ctx.data,
  });
  await ctx.answer('Decision received.');
}

async function handleTelegramMemoryReviewCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  reviewMatch: TelegramReviewMatch,
): Promise<void> {
  const decision = TELEGRAM_REVIEW_DECISION_BY_CODE[reviewMatch[1]];
  const reviewId = reviewMatch[2];
  if (!ctx.conversationJid) return;
  // The review message is SHARED. Route first, then split by terminality:
  // authority + the stale veto live in the host handler we dispatch to.
  const outcome = await channel.opts.onMessageAction?.({
    kind: 'memory_review_decision',
    conversationJid: ctx.conversationJid,
    ...(ctx.providerAccountId
      ? { providerAccountId: ctx.providerAccountId }
      : {}),
    threadId: ctx.threadId,
    userId: ctx.userId,
    reviewId,
    decision,
    label: '',
  });
  if (!outcome) {
    await ctx.answer();
    return;
  }
  const terminal =
    outcome.state === 'applied' ||
    outcome.state === 'stale' ||
    outcome.state === 'invalid';
  if (terminal) {
    // Ack is best-effort: an expired/failed callback query must NOT stop
    // the finalize — the shared message + its live keyboard have to come
    // down now that the review is resolved.
    await ctx
      .answer(outcome.receipt)
      .catch((err: unknown) =>
        logger.debug(
          { reviewId, err: channel.sanitizeErrorMessage(err) },
          'Failed to ack Telegram memory review callback',
        ),
      );
    await ctx.raw
      .editMessageText(outcome.receipt, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch((err: unknown) =>
        logger.debug(
          { reviewId, err: channel.sanitizeErrorMessage(err) },
          'Failed to update Telegram memory review message',
        ),
      );
  } else {
    // denied / edit: private alert to the clicker; leave the shared
    // message + keyboard intact for legitimate approvers. A failed
    // private ack shouldn't throw out of the handler.
    const text = outcome.replacementText
      ? `${outcome.receipt}\n\n${outcome.replacementText}`
      : outcome.receipt;
    await ctx
      .answer(text, true)
      .catch((err: unknown) =>
        logger.debug(
          { reviewId, err: channel.sanitizeErrorMessage(err) },
          'Failed to ack Telegram memory review callback',
        ),
      );
  }
}

async function handleTelegramBrainReviewCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  brainReviewMatch: TelegramReviewMatch,
): Promise<void> {
  const decision = TELEGRAM_BRAIN_REVIEW_DECISION_BY_CODE[brainReviewMatch[1]];
  const reviewId = brainReviewMatch[2];
  if (!ctx.conversationJid) return;
  // Owner-only authority + drift/at-most-once vetoes live in the host
  // handler; route first, then split by terminality like memory review.
  const outcome = await channel.opts.onMessageAction?.({
    kind: 'brain_dream_review_decision',
    conversationJid: ctx.conversationJid,
    ...(ctx.providerAccountId
      ? { providerAccountId: ctx.providerAccountId }
      : {}),
    threadId: ctx.threadId,
    userId: ctx.raw.from?.id?.toString() as string,
    reviewId,
    decision,
  });
  if (!outcome) {
    await ctx.answer();
    return;
  }
  const terminal =
    outcome.state === 'applied' ||
    outcome.state === 'stale' ||
    outcome.state === 'invalid';
  if (terminal) {
    await ctx
      .answer(outcome.receipt)
      .catch((err: unknown) =>
        logger.debug(
          { reviewId, err: channel.sanitizeErrorMessage(err) },
          'Failed to ack Telegram brain review callback',
        ),
      );
    await ctx.raw
      .editMessageText(outcome.receipt, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch((err: unknown) =>
        logger.debug(
          { reviewId, err: channel.sanitizeErrorMessage(err) },
          'Failed to update Telegram brain review message',
        ),
      );
  } else {
    // denied: private alert to the clicker; shared card + keyboard intact.
    const text = outcome.replacementText
      ? `${outcome.receipt}\n\n${outcome.replacementText}`
      : outcome.receipt;
    await ctx
      .answer(text, true)
      .catch((err: unknown) =>
        logger.debug(
          { reviewId, err: channel.sanitizeErrorMessage(err) },
          'Failed to ack Telegram brain review callback',
        ),
      );
  }
}

async function handleTelegramObserverCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  observer: TelegramObserverCallback,
): Promise<void> {
  const { action, insightId, localDay, chatId, threadId } = observer;
  if (!chatId) return;
  // Serialize concurrent clicks on THIS digest message so the later one
  // rebuilds from the earlier's committed state (no resurrected buttons).
  await withObserverDigestEditLock(
    `tg:${chatId}:${ctx.messageId ?? ''}`,
    async () => {
      const outcome = await channel.opts.onMessageAction?.({
        kind: 'observer_feedback',
        conversationJid: `tg:${chatId}`,
        ...(ctx.providerAccountId
          ? { providerAccountId: ctx.providerAccountId }
          : {}),
        ...(threadId ? { threadId } : {}),
        userId: ctx.userId ?? '',
        insightId,
        action,
        localDay,
      });
      if (!outcome) {
        await ctx.answer();
        return;
      }
      if (outcome.state === 'applied' && outcome.observerDigestView) {
        // One insight settled: rebuild the WHOLE digest (acted insight's row
        // gone + marker; the other insights keep their live buttons). Ack is
        // best-effort so an expired callback query can't block the edit.
        const rendered = telegramObserverDigestMessage(
          outcome.observerDigestView,
        );
        await ctx
          .answer(truncateTelegramCallbackAnswer(outcome.receipt))
          .catch((err: unknown) =>
            logger.debug(
              { insightId, err: channel.sanitizeErrorMessage(err) },
              'Failed to ack Telegram observer feedback callback',
            ),
          );
        await ctx.raw
          .editMessageText(rendered.text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: rendered.reply_markup,
          })
          .catch((err: unknown) =>
            logger.debug(
              { insightId, err: channel.sanitizeErrorMessage(err) },
              'Failed to rebuild Telegram observer digest message',
            ),
          );
      } else {
        // denied / stale / invalid: private alert to the clicker; the shared
        // digest keeps every live button intact.
        const text = outcome.replacementText
          ? `${outcome.receipt}\n\n${outcome.replacementText}`
          : outcome.receipt;
        await ctx
          .answer(truncateTelegramCallbackAnswer(text), true)
          .catch((err: unknown) =>
            logger.debug(
              { insightId, err: channel.sanitizeErrorMessage(err) },
              'Failed to ack Telegram observer feedback callback',
            ),
          );
      }
    },
  );
}

async function handleTelegramPermissionCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
): Promise<void> {
  const permissionMatch = TELEGRAM_PERMISSION_CALLBACK_PATTERN.exec(ctx.data);
  if (!permissionMatch) {
    if (ctx.data.startsWith('perm:')) {
      await ctx.answer('Permission request is no longer active.', true);
    }
    return;
  }
  const mode = normalizePermissionAction(permissionMatch[1]);
  if (!mode) return;
  const callbackId = permissionMatch[2];
  const pending = channel.pendingPermissionPrompts.get(callbackId);
  if (!pending) {
    await resolveDurableTelegramPermissionCallback({
      context: ctx.raw,
      appId: channel.opts.appId || 'default',
      providerAlias: callbackId,
      mode,
      sanitizeErrorMessage: channel.sanitizeErrorMessage,
      isAuthorized: (approvalContextJid, userId, recovered) =>
        channel.isTelegramApproverAuthorized(
          approvalContextJid.replace(/^tg:/, ''),
          userId,
          recovered.sourceAgentFolder,
          recovered.decisionPolicy as never,
          recovered.threadId ?? undefined,
        ),
    });
    return;
  }
  if (!permissionDecisionOptions(pending.request).includes(mode)) {
    await ctx.answer('This approval option is no longer available.', true);
    return;
  }
  const userId = await authorizePendingTelegramPermission(
    channel,
    ctx,
    pending,
  );
  if (!userId) return;
  const settled = await channel.claimAndResolvePermissionPrompt(
    callbackId,
    mode,
    userId,
    permissionSettlementReason(mode),
  );
  if (settled === 'already_decided') {
    await ctx.answer('Permission request was already decided.', true);
    return;
  }
  if (settled === 'retryable') {
    await ctx.answer('Could not record the decision. Please retry.', true);
    return;
  }
  await ctx.answer(permissionSettlementReceipt(mode, pending));
}

async function authorizePendingTelegramPermission(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  pending: PendingPermission,
): Promise<string | null> {
  const callbackChatId = telegramPermissionCallbackChatId(ctx);
  if (!callbackChatId) {
    await ctx.answer(
      'This approval request belongs to a different chat.',
      true,
    );
    return null;
  }
  if (callbackChatId !== pending.chatId) {
    await ctx.answer(
      'This approval request belongs to a different chat.',
      true,
    );
    return null;
  }
  const userId = telegramPermissionCallbackUserId(ctx);
  if (!userId) {
    await ctx.answer('Unable to verify approver identity.', true);
    return null;
  }
  const authorized = await channel.isTelegramApproverAuthorized(
    telegramPermissionApprovalChatId(pending),
    userId,
    pending.sourceAgentFolder,
    pending.decisionPolicy,
    pending.request.threadId,
  );
  if (authorized) return userId;
  await rejectUnauthorizedTelegramPermission(ctx, pending, userId);
  return null;
}

function telegramPermissionCallbackChatId(
  ctx: TelegramCallbackContext,
): string {
  return (
    ctx.raw.callbackQuery?.message?.chat?.id?.toString() ||
    ctx.raw.chat?.id?.toString() ||
    ''
  );
}

function telegramPermissionCallbackUserId(
  ctx: TelegramCallbackContext,
): string {
  return (
    ctx.raw.callbackQuery?.from?.id?.toString() ||
    ctx.raw.from?.id?.toString() ||
    ''
  );
}

function telegramPermissionApprovalChatId(pending: PendingPermission): string {
  return (pending.approvalContextJid || `tg:${pending.chatId}`).replace(
    /^tg:/,
    '',
  );
}

async function rejectUnauthorizedTelegramPermission(
  ctx: TelegramCallbackContext,
  pending: PendingPermission,
  userId: string,
): Promise<void> {
  logger.warn(
    {
      requestId: pending.request.requestId,
      userId,
      chatId:
        ctx.raw.callbackQuery?.message?.chat?.id?.toString() ||
        ctx.raw.chat?.id?.toString() ||
        pending.chatId,
      pendingChatId: pending.chatId,
      approvalContextJid: pending.approvalContextJid,
      sourceAgentFolder: pending.sourceAgentFolder,
      decisionPolicy: pending.decisionPolicy,
    },
    'Telegram permission decision rejected: user is not an approved administrator',
  );
  await ctx.answer('Only a conversation control approver can approve.', true);
}
function permissionSettlementReason(
  mode: NonNullable<PermissionApprovalDecision['mode']>,
): string {
  return mode === 'allow_once'
    ? 'allowed once via Telegram'
    : mode === 'allow_persistent_rule'
      ? 'persistent rule allowed via Telegram'
      : 'canceled via Telegram';
}

function permissionSettlementReceipt(
  mode: NonNullable<PermissionApprovalDecision['mode']>,
  pending: PendingPermission,
): string {
  return mode === 'allow_persistent_rule' && pending.request.permissionBatch
    ? 'Starting individual review.'
    : mode === 'allow_once'
      ? 'Allowed once.'
      : mode === 'allow_persistent_rule'
        ? 'Allowed for future.'
        : 'Canceled.';
}
