import {
  findDurableQuestionInteractionByRequestId,
  resolveDurableQuestionAnswersByRequestId,
} from '../../application/interactions/pending-interaction-durability.js';
import { logger } from '../../infrastructure/logging/logger.js';

export async function resolveDurableTelegramUserQuestionOtherReply(input: {
  chatId: string;
  requestId: string;
  questionIndex: number;
  text: string;
  userId: string;
  answeredBy: string;
  isApproverAuthorized: (
    chatId: string,
    userId: string,
    sourceAgentFolder: string,
  ) => Promise<boolean>;
  sendNotice: (chatId: string, text: string) => Promise<void>;
}): Promise<{ deletePrompt: boolean }> {
  const durable = await findDurableQuestionInteractionByRequestId({
    requestId: input.requestId,
  });
  if (!durable?.request || durable.targetJid !== `tg:${input.chatId}`) {
    return { deletePrompt: true };
  }
  const authorized = input.userId
    ? await input.isApproverAuthorized(
        input.chatId,
        input.userId,
        durable.sourceAgentFolder,
      )
    : false;
  if (!authorized) {
    await input.sendNotice(
      input.chatId,
      'Only a conversation control approver can answer.',
    );
    return { deletePrompt: false };
  }
  const answer = input.text.trim();
  if (!answer) {
    await input.sendNotice(input.chatId, 'Answer cannot be empty.');
    return { deletePrompt: false };
  }
  const question = durable.request.questions[input.questionIndex];
  if (!question) return { deletePrompt: true };
  const resolved = await resolveDurableQuestionAnswersByRequestId({
    requestId: input.requestId,
    answers: {
      [question.question]: question.multiSelect ? [answer] : answer,
    },
    answeredBy: input.answeredBy,
  });
  if (resolved) return { deletePrompt: true };
  await input.sendNotice(input.chatId, 'Question is no longer active.');
  return { deletePrompt: false };
}

export async function sendTelegramUserQuestionOtherReplyNotice(input: {
  bot: {
    api: { sendMessage: (chatId: string, text: string) => Promise<unknown> };
  } | null;
  chatId: string;
  text: string;
  sanitizeErrorMessage: (err: unknown) => unknown;
}): Promise<void> {
  if (!input.bot) return;
  try {
    await input.bot.api.sendMessage(input.chatId, input.text);
  } catch (err) {
    logger.debug(
      { chatId: input.chatId, err: input.sanitizeErrorMessage(err) },
      'Failed to send Telegram user question reply notice',
    );
  }
}
