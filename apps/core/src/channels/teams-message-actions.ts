import type {
  MemoryReviewActionDecision,
  MessageActionOutcome,
  OnMessageAction,
} from '../domain/types.js';
import type { TeamsAdaptiveCardPayload } from './teams-cards.js';
import { buildTeamsReviewReceiptCard } from './teams-cards.js';
import type { TeamsInboundMessage } from './teams-types.js';
import { teamsConversationIdFromJid } from './teams-types.js';

export function readTeamsMessageAction(value: unknown):
  | {
      kind: 'live_turn_stop';
      actionToken: string;
      targetJid: string;
      threadId?: string;
    }
  | {
      kind: 'scheduler_run_now';
      jobId: string;
      targetJid: string;
      threadId?: string;
    }
  | {
      kind: 'memory_review_decision';
      reviewId: string;
      decision: MemoryReviewActionDecision;
      targetJid: string;
      threadId?: string;
    }
  | null {
  const data =
    typeof value === 'object' && value !== null && 'data' in value
      ? (value as { data?: unknown }).data
      : value;
  if (typeof data !== 'object' || data === null) return null;
  const payload = data as Record<string, unknown>;
  if (payload.action !== 'message_action') return null;
  if (typeof payload.targetJid !== 'string') {
    return null;
  }
  if (payload.kind === 'memory_review_decision') {
    if (typeof payload.reviewId !== 'string' || !payload.reviewId.trim()) {
      return null;
    }
    if (
      payload.decision !== 'approve' &&
      payload.decision !== 'reject' &&
      payload.decision !== 'edit'
    ) {
      return null;
    }
    return {
      kind: 'memory_review_decision',
      reviewId: payload.reviewId,
      decision: payload.decision,
      targetJid: payload.targetJid,
      ...(typeof payload.threadId === 'string'
        ? { threadId: payload.threadId }
        : {}),
    };
  }
  if (payload.kind === 'scheduler_run_now') {
    if (typeof payload.jobId !== 'string' || !payload.jobId.trim()) {
      return null;
    }
    return {
      kind: 'scheduler_run_now',
      jobId: payload.jobId,
      targetJid: payload.targetJid,
      ...(typeof payload.threadId === 'string'
        ? { threadId: payload.threadId }
        : {}),
    };
  }
  if (payload.kind !== 'live_turn_stop') return null;
  if (typeof payload.actionToken !== 'string') return null;
  return {
    kind: 'live_turn_stop',
    actionToken: payload.actionToken,
    targetJid: payload.targetJid,
    ...(typeof payload.threadId === 'string'
      ? { threadId: payload.threadId }
      : {}),
  };
}

function isTerminalReviewOutcome(outcome: MessageActionOutcome): boolean {
  return (
    outcome.state === 'applied' ||
    outcome.state === 'stale' ||
    outcome.state === 'invalid'
  );
}

export async function handleTeamsMessageAction(input: {
  message: TeamsInboundMessage;
  jid: string;
  userId: string;
  providerAccountId?: string;
  onMessageAction?: OnMessageAction;
  sendDenied: (conversationId: string | null, text: string) => Promise<void>;
  updateReviewCard?: (params: {
    conversationId: string;
    messageId: string;
    card: TeamsAdaptiveCardPayload;
  }) => Promise<void>;
}): Promise<boolean> {
  const payload = readTeamsMessageAction(input.message.value);
  if (!payload) return false;
  if (payload.targetJid !== input.jid) {
    await input.sendDenied(
      teamsConversationIdFromJid(input.jid),
      'This action belongs to a different chat.',
    );
    return true;
  }
  if (payload.kind === 'memory_review_decision') {
    const outcome = await input.onMessageAction?.({
      kind: 'memory_review_decision',
      conversationJid: input.jid,
      ...(input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
      userId: input.userId,
      reviewId: payload.reviewId,
      decision: payload.decision,
      label: '',
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
    });
    if (!outcome) return true;
    const conversationId = teamsConversationIdFromJid(input.jid);
    if (isTerminalReviewOutcome(outcome)) {
      // Review resolved/gone: rebuild the SHARED card as a receipt with no
      // action buttons, so everyone sees the outcome and can't re-click.
      const messageId = input.message.replyToId ?? input.message.id;
      if (conversationId && messageId && input.updateReviewCard) {
        await input.updateReviewCard({
          conversationId,
          messageId,
          card: buildTeamsReviewReceiptCard(outcome.receipt),
        });
      }
    } else {
      // denied / needs_input[edit]: never touch the shared card. Teams' invoke
      // path here has no per-user ephemeral, so the smallest blast radius is a
      // chat message; the shared review context others rely on stays intact.
      // ponytail: post-to-conversation; swap for a true ephemeral if the SDK
      // ever exposes one.
      const text = outcome.replacementText
        ? `${outcome.receipt}\n\n${outcome.replacementText}`
        : outcome.receipt;
      await input.sendDenied(conversationId, text);
    }
    return true;
  }
  if (payload.kind === 'scheduler_run_now') {
    await input.onMessageAction?.({
      kind: 'scheduler_run_now',
      conversationJid: input.jid,
      ...(input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
      userId: input.userId,
      jobId: payload.jobId,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
    });
    return true;
  }
  await input.onMessageAction?.({
    kind: 'live_turn_stop',
    conversationJid: input.jid,
    ...(input.providerAccountId
      ? { providerAccountId: input.providerAccountId }
      : {}),
    userId: input.userId,
    actionToken: payload.actionToken,
    ...(payload.threadId ? { threadId: payload.threadId } : {}),
  });
  return true;
}
