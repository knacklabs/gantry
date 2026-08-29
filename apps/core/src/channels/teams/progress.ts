import type {
  MessageDeliveryResult,
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../../domain/types.js';
import {
  buildTeamsMessageCard,
  teamsObserverDigestCard,
  teamsReviewCard,
  teamsBrainReviewCard,
} from './cards.js';
import { sendTeamsTextMessage } from './delivery.js';
import type { TeamsSdkClient } from './types.js';
import { teamsConversationIdFromJid } from './types.js';
import type { JobPermissionCardDeliverySettlement } from '../interaction-settlement.js';
import { settleJobPermissionCardRetire } from '../job-permission-card-settlement.js';

export type TeamsProgressMessages = Map<
  string,
  { conversationId: string; messageId?: string }
>;

function teamsProgressGenerationKey(input: {
  jid: string;
  threadId?: string;
  generation?: number;
}): string {
  return `${input.jid}:${input.threadId || ''}:${input.generation ?? 0}`;
}

function teamsProgressControlKey(input: {
  jid: string;
  threadId?: string;
}): string {
  return `${input.jid}:${input.threadId || ''}:control`;
}

function hasLiveTurnStopAction(options: ProgressUpdateOptions): boolean {
  return Boolean(
    options.actionAffordances?.some(
      (action) => action.kind === 'live_turn_stop',
    ),
  );
}

export async function sendTeamsTextOrActionMessage(input: {
  sdkClient: TeamsSdkClient;
  jid: string;
  text: string;
  options?: MessageSendOptions;
  jobPermissionCardDeliveries: JobPermissionCardDeliverySettlement;
}): Promise<MessageDeliveryResult | void> {
  const options = input.options ?? {};
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) return;
  if (options.jobPermissionCardRevision?.operation === 'retire') {
    const providerMessageId =
      options.deleteMessageId ?? options.replaceMessageId;
    return settleJobPermissionCardRetire({
      deliveries: input.jobPermissionCardDeliveries,
      scope: conversationId,
      providerMessageId,
      options,
      deliverReceipt: async () => {
        if (providerMessageId) {
          if (!input.sdkClient.updateAdaptiveCard) {
            throw new Error('Teams job permission card update is unavailable.');
          }
          const updated = await input.sdkClient.updateAdaptiveCard({
            conversationId,
            messageId: providerMessageId,
            card: buildTeamsMessageCard({
              text: input.text,
              targetJid: input.jid,
              threadId: options.threadId,
              actionAffordances: [],
            }),
            ...(options.threadId ? { threadId: options.threadId } : {}),
          });
          return updated.externalMessageId ?? providerMessageId;
        }
        const sent = await sendTeamsTextMessage(
          input.sdkClient,
          conversationId,
          input.text,
          options,
        );
        if (!sent?.externalMessageId) {
          throw new Error('Teams job permission receipt has no activity id.');
        }
        return sent.externalMessageId;
      },
    });
  }
  if (options.observerDigestView && input.sdkClient.sendAdaptiveCard) {
    return input.sdkClient.sendAdaptiveCard({
      conversationId,
      card: teamsObserverDigestCard(options.observerDigestView, {
        targetJid: input.jid,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      }),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
  }
  if (options.reviewMessageView && input.sdkClient.sendAdaptiveCard) {
    return input.sdkClient.sendAdaptiveCard({
      conversationId,
      card: teamsReviewCard(options.reviewMessageView, {
        targetJid: input.jid,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      }),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
  }
  if (options.brainReviewView && input.sdkClient.sendAdaptiveCard) {
    return input.sdkClient.sendAdaptiveCard({
      conversationId,
      card: teamsBrainReviewCard(options.brainReviewView, {
        targetJid: input.jid,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      }),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
  }
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
}): Promise<boolean> {
  const options = input.options ?? {};
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) return false;
  const generationKey = teamsProgressGenerationKey({
    jid: input.jid,
    threadId: options.threadId,
    generation: options.generation,
  });
  const controlKey = teamsProgressControlKey({
    jid: input.jid,
    threadId: options.threadId,
  });
  const key =
    hasLiveTurnStopAction(options) ||
    (options.done && input.pendingProgress.has(controlKey))
      ? controlKey
      : generationKey;
  const existing = input.pendingProgress.get(key);
  if (!input.sdkClient.sendAdaptiveCard) {
    if (!options.replaceOnly) {
      await sendTeamsTextMessage(
        input.sdkClient,
        conversationId,
        input.text,
        options,
      );
      return true;
    }
    return false;
  }
  const card = buildTeamsMessageCard({
    text: input.text,
    targetJid: input.jid,
    threadId: options.threadId,
    actionOnly: options.actionOnly,
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
    return true;
  }
  if (options.replaceOnly) return false;
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
  return true;
}
