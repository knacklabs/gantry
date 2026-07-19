import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionApprovalDecisionMode,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import {
  claimPermissionInteractionCallback,
  DurableInteractionPersistenceError,
  recoverDurablePermissionDecision,
  recordDurableQuestionAnswerProgress,
  releasePermissionInteractionCallback,
  samePermissionCallbackLocator,
} from '../application/interactions/pending-interaction-durability.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  decisionForMode,
  formatPermissionReceiptText,
  normalizePermissionAction,
  permissionDecisionOptions,
} from './permission-interaction.js';
import {
  buildTeamsMessageCard,
  buildTeamsUserQuestionReceiptCard,
} from './teams-cards.js';
import {
  formatTeamsUserQuestionReceipt,
  mapTeamsUserQuestionAnswers,
  readTeamsUserQuestionSubmit,
  type TeamsUserQuestionSubmit,
} from './teams-user-question.js';
import { readTeamsPermissionDecision } from './teams-permission-submit.js';
import {
  teamsConversationIdFromJid,
  type PendingTeamsPermissionPrompt,
  type PendingTeamsUserQuestion,
  type TeamsChannelOpts,
  type TeamsInboundMessage,
  type TeamsSdkClient,
} from './teams-types.js';

type TeamsInteractionContext = {
  opts: TeamsChannelOpts;
  sdkClient: TeamsSdkClient;
  pendingPermissionPrompts: Map<string, PendingTeamsPermissionPrompt>;
  pendingUserQuestions: Map<string, PendingTeamsUserQuestion>;
};

export function dropPendingTeamsInteraction(
  context: TeamsInteractionContext,
  kind: 'permission' | 'question',
  request: PermissionApprovalRequest | UserQuestionRequest,
): void {
  const pendingInteractions =
    kind === 'permission'
      ? context.pendingPermissionPrompts
      : context.pendingUserQuestions;
  for (const [providerAlias, pending] of pendingInteractions) {
    if (
      pending.request.requestId !== request.requestId ||
      pending.sourceAgentFolder !== request.sourceAgentFolder ||
      (pending.request.appId || 'default') !== (request.appId || 'default')
    ) {
      continue;
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    pendingInteractions.delete(providerAlias);
  }
}

export async function handleTeamsUserQuestionSubmit(input: {
  message: TeamsInboundMessage;
  jid: string;
  userId: string;
  userName: string;
  context: TeamsInteractionContext;
}): Promise<boolean> {
  const submit = readTeamsUserQuestionSubmit(input.message.value);
  if (!submit) return false;
  const candidate = input.context.pendingUserQuestions.get(
    submit.callback.providerAlias,
  );
  const pending =
    candidate && sameTeamsQuestionCallback(candidate.callback, submit.callback)
      ? candidate
      : undefined;
  if (!pending) return true;
  if (pending.settled) return true;
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId || conversationId !== pending.conversationId) {
    await sendDeniedTeamsDecisionFeedback(
      input.context,
      conversationId || teamsConversationIdFromJid(input.jid),
      'This question belongs to a different chat.',
    );
    return true;
  }
  const authorized = await canDecideTeamsPermission(
    input.context,
    input.userId,
    pending.sourceAgentFolder,
    undefined,
    input.jid,
  );
  if (!authorized) {
    await sendDeniedTeamsDecisionFeedback(
      input.context,
      conversationId,
      'You are not allowed to answer this question.',
    );
    return true;
  }
  const answers = mapTeamsUserQuestionAnswers(pending.request, submit.values);
  let recorded: boolean;
  try {
    recorded = await recordDurableQuestionAnswerProgress({
      requestId: pending.request.requestId,
      appId: pending.request.appId,
      sourceAgentFolder: pending.request.sourceAgentFolder,
      answers,
      completedQuestionIndexes: pending.request.questions.flatMap((_, index) =>
        index >= pending.callback.questionIndex ? [index] : [],
      ),
    });
  } catch (err) {
    throw err instanceof DurableInteractionPersistenceError
      ? err
      : new DurableInteractionPersistenceError(
          'Teams user question answers could not be persisted',
          err,
        );
  }
  if (!recorded) {
    throw new DurableInteractionPersistenceError(
      'Teams user question answers were not persisted',
    );
  }
  await resolvePendingTeamsUserQuestion(
    input.context,
    submit.callback.providerAlias,
    {
      requestId: submit.callback.scope.interactionId,
      answers,
      answeredBy: input.userName,
    },
  );
  return true;
}

export async function resolvePendingTeamsUserQuestion(
  context: TeamsInteractionContext,
  providerAlias: string,
  response: UserQuestionResponse,
): Promise<void> {
  const pending = context.pendingUserQuestions.get(providerAlias);
  if (!pending || pending.settled) return;
  pending.settled = true;
  context.pendingUserQuestions.delete(providerAlias);
  clearTimeout(pending.timer);
  pending.resolve(response);
  const answered = Object.keys(response.answers).length > 0;
  const receiptText = answered
    ? formatTeamsUserQuestionReceipt(pending.request, response)
    : 'No answer was recorded for the question.';
  if (context.sdkClient.updateAdaptiveCard && pending.messageId) {
    try {
      await context.sdkClient.updateAdaptiveCard({
        conversationId: pending.conversationId,
        messageId: pending.messageId,
        card: buildTeamsUserQuestionReceiptCard(receiptText),
      });
      return;
    } catch (err) {
      logger.debug(
        { requestId: pending.request.requestId, err },
        'Teams user question receipt card update failed; sending text',
      );
    }
  }
  try {
    await context.sdkClient.sendMessage({
      conversationId: pending.conversationId,
      text: receiptText,
      ...(pending.threadId ? { threadId: pending.threadId } : {}),
    });
  } catch (err) {
    logger.debug(
      { requestId: pending.request.requestId, err },
      'Failed to send Teams user question receipt',
    );
  }
}

export async function handleTeamsPermissionDecision(input: {
  message: TeamsInboundMessage;
  jid: string;
  userId: string;
  userName: string;
  context: TeamsInteractionContext;
}): Promise<boolean> {
  const decisionPayload = readTeamsPermissionDecision(input.message.value);
  if (!decisionPayload) return false;
  const pending = input.context.pendingPermissionPrompts.get(
    decisionPayload.callback.providerAlias,
  );
  const mode = normalizePermissionAction(decisionPayload.decision);
  if (!pending) {
    if (mode) {
      await recoverDurablePermissionDecision({
        locator: {
          kind: 'scope',
          scope: decisionPayload.callback.scope,
          matchKind: decisionPayload.callback.matchKind,
          providerAlias: decisionPayload.callback.providerAlias,
        },
        surfaceJid: input.jid,
        incomingMode: mode,
        incomingApprover: input.userId,
        authorize: (durable) =>
          canDecideTeamsPermission(
            input.context,
            input.userId,
            durable.sourceAgentFolder,
            durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
            durable.approvalContextJid ?? '',
            durable.threadId ?? undefined,
          ),
        terminalize: (receipt) =>
          terminalizeTeamsPermissionPrompt(
            input.context,
            {
              conversationId:
                receipt.status === 'resolved'
                  ? (receipt.context.externalPromptConversationId ??
                    teamsConversationIdFromJid(input.jid)!)
                  : teamsConversationIdFromJid(input.jid)!,
              messageId:
                receipt.status === 'resolved'
                  ? (receipt.context.externalPromptMessageId ??
                    input.message.replyToId ??
                    input.message.id)
                  : (input.message.replyToId ?? input.message.id),
              threadId:
                receipt.status === 'resolved'
                  ? (receipt.context.externalPromptThreadId ??
                    receipt.context.threadId ??
                    undefined)
                  : input.message.threadId,
              request: receipt.status === 'resolved' ? receipt.request : null,
            },
            receipt.decision,
            receipt.status === 'expired' ? receipt.text : undefined,
          ),
        feedback: (text) =>
          sendDeniedTeamsDecisionFeedback(
            input.context,
            teamsConversationIdFromJid(input.jid),
            text,
          ),
      });
    }
    return true;
  }
  if (pending.settled) {
    await sendDeniedTeamsDecisionFeedback(
      input.context,
      pending.conversationId,
      'This permission request was already decided.',
    );
    return true;
  }
  if (
    !samePermissionCallbackLocator(pending.callback, decisionPayload.callback)
  ) {
    return true;
  }
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId || conversationId !== pending.conversationId) {
    logger.warn(
      { requestId: pending.request.requestId, jid: input.jid },
      'Teams permission decision denied: wrong channel',
    );
    await sendDeniedTeamsDecisionFeedback(
      input.context,
      conversationId || teamsConversationIdFromJid(input.jid),
      'This approval request belongs to a different chat.',
    );
    return true;
  }
  const authorized = await canDecideTeamsPermission(
    input.context,
    input.userId,
    pending.sourceAgentFolder,
    pending.decisionPolicy,
    pending.approvalContextJid || input.jid,
    pending.threadId,
  );
  if (!authorized) {
    logger.warn(
      {
        requestId: pending.request.requestId,
        userId: input.userId,
        jid: input.jid,
      },
      'Teams permission decision denied: user is not a control approver',
    );
    await sendDeniedTeamsDecisionFeedback(
      input.context,
      conversationId,
      'You are not allowed to decide this permission request.',
    );
    return true;
  }
  if (!mode) return true;
  if (!permissionDecisionOptions(pending.request).includes(mode)) {
    await sendDeniedTeamsDecisionFeedback(
      input.context,
      conversationId,
      'This approval option is no longer available.',
    );
    return true;
  }
  const result = await settlePendingTeamsPermission(
    input.context,
    decisionPayload.callback.providerAlias,
    mode,
    input.userId,
  );
  if (result === 'already_decided' || result === 'ownerless') {
    await sendDeniedTeamsDecisionFeedback(
      input.context,
      conversationId,
      'This permission request was already decided.',
    );
  }
  return true;
}

export async function resolveTeamsPermissionPrompt(
  context: TeamsInteractionContext,
  providerAlias: string,
  decision: PermissionApprovalDecision,
): Promise<boolean> {
  const pending = context.pendingPermissionPrompts.get(providerAlias);
  if (!pending || pending.settled) return false;
  if (!(await terminalizeTeamsPermissionPrompt(context, pending, decision))) {
    return false;
  }
  pending.settled = true;
  context.pendingPermissionPrompts.delete(providerAlias);
  clearTimeout(pending.timer);
  pending.resolve(decision);
  return true;
}

export async function settlePendingTeamsPermission(
  context: TeamsInteractionContext,
  providerAlias: string,
  mode: PermissionApprovalDecisionMode,
  approverRef: string,
  reason?: string,
): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'> {
  const pending = context.pendingPermissionPrompts.get(providerAlias);
  if (!pending || pending.settled) return 'already_decided';
  const claimed = await claimPermissionInteractionCallback({
    scope: pending.callback.scope,
    mode,
    approverRef,
    matchKind: pending.callback.matchKind,
    providerAlias,
  });
  if (claimed.status === 'already_decided')
    return claimed.ownerless ? 'ownerless' : 'already_decided';
  if (claimed.status === 'retryable') return 'retryable';
  const decision = {
    ...decisionForMode(pending.request, mode, approverRef),
    ...(reason ? { reason } : {}),
    permissionCallbackClaim: claimed.claim,
  };
  if (await resolveTeamsPermissionPrompt(context, providerAlias, decision)) {
    return 'settled';
  }
  await releasePermissionInteractionCallback({ claim: claimed.claim });
  return 'retryable';
}

async function terminalizeTeamsPermissionPrompt(
  context: TeamsInteractionContext,
  prompt: {
    conversationId: string;
    messageId?: string;
    threadId?: string;
    request: PermissionApprovalRequest | null;
  },
  decision: PermissionApprovalDecision,
  receiptText?: string,
): Promise<boolean> {
  const requestId =
    prompt.request?.requestId ??
    decision.permissionCallbackClaim?.scope.interactionId ??
    'permission';
  const resolvedReceiptText =
    receiptText ??
    (prompt.request
      ? formatPermissionReceiptText(requestId, prompt.request, decision)
      : decision.approved
        ? 'Permission allowed.'
        : 'Permission cancelled.');
  let updated = false;
  if (context.sdkClient.updateAdaptiveCard && prompt.messageId) {
    try {
      await context.sdkClient.updateAdaptiveCard({
        conversationId: prompt.conversationId,
        messageId: prompt.messageId,
        card: buildTeamsMessageCard({
          text:
            decision.approved && decision.mode !== 'cancel'
              ? '\u200B'
              : resolvedReceiptText,
          targetJid: `teams:${prompt.conversationId}`,
          threadId: prompt.threadId,
        }),
        ...(prompt.threadId ? { threadId: prompt.threadId } : {}),
      });
      updated = true;
    } catch (err) {
      logger.debug(
        { requestId, err },
        'Failed to update Teams permission prompt; sending receipt fallback',
      );
    }
  }
  if (!updated) {
    try {
      await context.sdkClient.sendMessage({
        conversationId: prompt.conversationId,
        text: resolvedReceiptText,
        ...(prompt.threadId ? { threadId: prompt.threadId } : {}),
      });
      return true;
    } catch (err) {
      logger.debug(
        { requestId, err },
        'Failed to send Teams permission receipt',
      );
      return false;
    }
  }
  return true;
}

function sameTeamsQuestionCallback(
  left: PendingTeamsUserQuestion['callback'],
  right: PendingTeamsUserQuestion['callback'],
): boolean {
  return (
    left.providerAlias === right.providerAlias &&
    left.questionIndex === right.questionIndex &&
    left.scope.appId === right.scope.appId &&
    left.scope.sourceAgentFolder === right.scope.sourceAgentFolder &&
    left.scope.interactionId === right.scope.interactionId
  );
}

async function canDecideTeamsPermission(
  context: TeamsInteractionContext,
  userId: string,
  sourceAgentFolder: string,
  decisionPolicy: PermissionApprovalRequest['decisionPolicy'] | undefined,
  conversationJid: string,
  threadId?: string,
): Promise<boolean> {
  if (decisionPolicy && decisionPolicy !== 'same_channel') return false;
  if (!context.opts.isControlApproverAllowed) return false;
  return context.opts.isControlApproverAllowed({
    providerId: 'teams',
    providerAccountId: context.opts.providerAccountId,
    agentId: context.opts.agentId,
    conversationJid,
    threadId,
    userId,
    sourceAgentFolder,
    decisionPolicy,
  });
}

async function sendDeniedTeamsDecisionFeedback(
  context: TeamsInteractionContext,
  conversationId: string | null,
  text: string,
): Promise<void> {
  if (!conversationId) return;
  try {
    await context.sdkClient.sendMessage({ conversationId, text });
  } catch (err) {
    logger.debug(
      { conversationId, err },
      'Failed to send Teams permission denial feedback',
    );
  }
}
