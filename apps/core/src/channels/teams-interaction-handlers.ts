import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import {
  findDurablePermissionInteractionByRequestId,
  findDurableQuestionInteractionByRequestId,
  resolveDurablePermissionInteractionByRequestId,
  resolveDurableQuestionAnswersByRequestId,
} from '../application/interactions/pending-interaction-durability.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  decisionForMode,
  formatPermissionReceiptText,
  normalizePermissionAction,
  permissionDecisionOptions,
} from './permission-interaction.js';
import { buildTeamsUserQuestionReceiptCard } from './teams-cards.js';
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

export async function handleTeamsUserQuestionSubmit(input: {
  message: TeamsInboundMessage;
  jid: string;
  userId: string;
  userName: string;
  context: TeamsInteractionContext;
}): Promise<boolean> {
  const submit = readTeamsUserQuestionSubmit(input.message.value);
  if (!submit) return false;
  const pending = input.context.pendingUserQuestions.get(submit.requestId);
  if (!pending) {
    await resolveDurableTeamsUserQuestionSubmit({ ...input, submit });
    return true;
  }
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
  await resolvePendingTeamsUserQuestion(input.context, submit.requestId, {
    requestId: submit.requestId,
    answers,
    answeredBy: input.userName,
  });
  return true;
}

export async function resolvePendingTeamsUserQuestion(
  context: TeamsInteractionContext,
  requestId: string,
  response: UserQuestionResponse,
): Promise<void> {
  const pending = context.pendingUserQuestions.get(requestId);
  if (!pending || pending.settled) return;
  pending.settled = true;
  context.pendingUserQuestions.delete(requestId);
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
        { requestId, err },
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
      { requestId, err },
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
    decisionPayload.requestId,
  );
  const mode = normalizePermissionAction(decisionPayload.decision);
  if (!pending) {
    if (mode) {
      const durable = await findDurablePermissionInteractionByRequestId({
        requestId: decisionPayload.requestId,
      });
      const authorized =
        durable?.targetJid === input.jid &&
        (await canDecideTeamsPermission(
          input.context,
          input.userId,
          durable.sourceAgentFolder,
          durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
          input.jid,
          durable.threadId ?? undefined,
        ));
      if (authorized) {
        await resolveDurablePermissionInteractionByRequestId({
          requestId: decisionPayload.requestId,
          mode,
          approverRef: input.userName,
          reason: `resolved via Teams after channel restart`,
        });
      }
    }
    return true;
  }
  if (pending.settled) return true;
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId || conversationId !== pending.conversationId) {
    logger.warn(
      { requestId: decisionPayload.requestId, jid: input.jid },
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
        requestId: decisionPayload.requestId,
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
  await resolveTeamsPermissionPrompt(
    input.context,
    decisionPayload.requestId,
    decisionForMode(pending.request, mode, input.userName),
  );
  return true;
}

export async function resolveTeamsPermissionPrompt(
  context: TeamsInteractionContext,
  requestId: string,
  decision: PermissionApprovalDecision,
): Promise<void> {
  const pending = context.pendingPermissionPrompts.get(requestId);
  if (!pending || pending.settled) return;
  pending.settled = true;
  context.pendingPermissionPrompts.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(decision);
  try {
    await context.sdkClient.sendMessage({
      conversationId: pending.conversationId,
      text: formatPermissionReceiptText(requestId, pending.request, decision),
      ...(pending.threadId ? { threadId: pending.threadId } : {}),
    });
  } catch (err) {
    logger.debug({ requestId, err }, 'Failed to send Teams permission receipt');
  }
}

async function resolveDurableTeamsUserQuestionSubmit(input: {
  submit: TeamsUserQuestionSubmit;
  jid: string;
  userId: string;
  userName: string;
  context: TeamsInteractionContext;
}): Promise<void> {
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) return;
  const durable = await findDurableQuestionInteractionByRequestId({
    requestId: input.submit.requestId,
  });
  if (!durable || durable.targetJid !== input.jid || !durable.request) {
    return;
  }
  const authorized = await canDecideTeamsPermission(
    input.context,
    input.userId,
    durable.sourceAgentFolder,
    undefined,
    input.jid,
  );
  if (!authorized) {
    await sendDeniedTeamsDecisionFeedback(
      input.context,
      conversationId,
      'You are not allowed to answer this question.',
    );
    return;
  }
  await resolveDurableQuestionAnswersByRequestId({
    requestId: input.submit.requestId,
    answers: mapTeamsUserQuestionAnswers(durable.request, input.submit.values),
    answeredBy: input.userName,
  });
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
