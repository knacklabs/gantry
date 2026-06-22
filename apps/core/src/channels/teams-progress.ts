import type {
  MessageDeliveryResult,
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { buildTeamsMessageCard } from './teams-cards.js';
import { sendTeamsTextMessage } from './teams-delivery.js';
import type { TeamsSdkClient } from './teams-types.js';
import { teamsConversationIdFromJid } from './teams-types.js';

export type TeamsProgressMessages = Map<
  string,
  { conversationId: string; messageId?: string }
>;

export async function sendTeamsTextOrActionMessage(input: {
  sdkClient: TeamsSdkClient;
  jid: string;
  text: string;
  options?: MessageSendOptions;
}): Promise<MessageDeliveryResult | void> {
  const options = input.options ?? {};
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) return;
  if (options.actionAffordances?.length && input.sdkClient.sendAdaptiveCard) {
    return input.sdkClient.sendAdaptiveCard({
      conversationId,
      card: buildTeamsMessageCard({
        text: input.text,
        targetJid: input.jid,
        threadId: options.threadId,
        actionAffordances: options.actionAffordances,
      }),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
  }
  return sendTeamsTextMessage(
    input.sdkClient,
    conversationId,
    input.text,
    options,
  );
}

export async function sendTeamsProgressUpdate(input: {
  sdkClient: TeamsSdkClient;
  pendingProgress: TeamsProgressMessages;
  jid: string;
  text: string;
  options?: ProgressUpdateOptions;
}): Promise<void> {
  const options = input.options ?? {};
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) return;
  const key = `${input.jid}:${options.threadId || ''}:${options.generation ?? 0}`;
  const existing = input.pendingProgress.get(key);
  if (!input.sdkClient.sendAdaptiveCard) {
    if (!options.replaceOnly) {
      await sendTeamsTextMessage(
        input.sdkClient,
        conversationId,
        input.text,
        options,
      );
    }
    return;
  }
  const card = buildTeamsMessageCard({
    text: input.text,
    targetJid: input.jid,
    threadId: options.threadId,
    actionAffordances: options.done ? [] : options.actionAffordances,
  });
  if (existing?.messageId && input.sdkClient.updateAdaptiveCard) {
    await input.sdkClient.updateAdaptiveCard({
      conversationId,
      messageId: existing.messageId,
      card,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
    if (options.done) input.pendingProgress.delete(key);
    return;
  }
  if (options.replaceOnly) return;
  const sent = await input.sdkClient.sendAdaptiveCard({
    conversationId,
    card,
    ...(options.threadId ? { threadId: options.threadId } : {}),
  });
  if (!options.done) {
    input.pendingProgress.set(key, {
      conversationId,
      messageId: sent.externalMessageId,
    });
  }
}
