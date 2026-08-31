import type {
  MemoryReviewActionDecision,
  MessageActionAffordanceKind,
  MessageActionOutcome,
  OnMessageAction,
} from '../../domain/types.js';
import {
  parseSlackObserverFeedback,
  slackObserverDigestBlocks,
  slackObserverDigestFallbackText,
} from './observer-digest-affordances.js';
import { parseSlackBrainReview } from './brain-review-affordances.js';
import { withObserverDigestEditLock } from '../observer-digest-edit-lock.js';

const SCHEDULER_MESSAGE_ACTION_KINDS = new Set<MessageActionAffordanceKind>([
  'scheduler_run_now',
  'scheduler_pause_job',
]);

type SlackAppLike = {
  action: (
    name: string | RegExp,
    handler: (args: any) => Promise<void>,
  ) => void;
  client: {
    chat: {
      postEphemeral: (input: any) => Promise<unknown>;
      update: (input: any) => Promise<unknown>;
    };
  };
};

/**
 * The review message is SHARED in the channel. Terminal outcomes (applied /
 * stale / invalid — the review is resolved or gone) are safe for everyone, so
 * we replace the shared message with the receipt and drop the buttons.
 * Non-terminal outcomes (denied / needs_input[edit]) go PRIVATELY to the
 * clicker and never touch the shared message — a denial from an unauthorized
 * member, or an edit prompt, must not destroy the review context others rely on.
 */
function isTerminalReviewOutcome(outcome: MessageActionOutcome): boolean {
  return (
    outcome.state === 'applied' ||
    outcome.state === 'stale' ||
    outcome.state === 'invalid'
  );
}

export function registerSlackMessageActionHandler(
  app: SlackAppLike,
  opts?: {
    onMessageAction?: OnMessageAction;
    providerAccountId?: string;
  },
): void {
  // Buttons carry index-suffixed ids (gantry_message_action:<i>) because
  // Slack rejects duplicate action_ids in one block; the bare id still
  // matches for any legacy message that predates the suffix.
  app.action(/^gantry_message_action(:\d+)?$/, async (args: any) => {
    const action = args.action as { value?: string };
    const body = args.body as {
      channel?: { id?: string };
      message?: { thread_ts?: string; ts?: string };
      user?: { id?: string };
    };
    const channelId = body.channel?.id;
    const userId = body.user?.id;
    let payload:
      | {
          kind?: unknown;
          jobId?: unknown;
          runId?: unknown;
          reviewId?: unknown;
          decision?: unknown;
          actionToken?: unknown;
          providerAccountId?: unknown;
        }
      | undefined;
    try {
      payload = action.value ? JSON.parse(action.value) : undefined;
    } catch {
      await args.ack();
      return;
    }
    if (
      payload?.kind === 'job_permission_decision' &&
      typeof payload.actionToken === 'string' &&
      payload.actionToken.trim() &&
      channelId &&
      userId
    ) {
      await opts?.onMessageAction?.({
        kind: 'job_permission_decision',
        conversationJid: `sl:${channelId}`,
        ...providerAccountFromPayload(payload, opts?.providerAccountId),
        threadId: body.message?.thread_ts,
        userId,
        ...(body.message?.ts ? { messageId: body.message.ts } : {}),
        actionToken: payload.actionToken,
      });
      await args.ack();
      return;
    }
    await args.ack();
    const observerFeedback = parseSlackObserverFeedback(payload);
    if (observerFeedback && channelId && userId) {
      const messageTs = body.message?.ts;
      // Serialize concurrent clicks on THIS digest message so the later one
      // rebuilds from the earlier's committed state (no resurrected buttons).
      await withObserverDigestEditLock(
        `sl:${channelId}:${messageTs ?? ''}`,
        async () => {
          const outcome = await opts?.onMessageAction?.({
            kind: 'observer_feedback',
            conversationJid: `sl:${channelId}`,
            ...providerAccountFromPayload(
              { providerAccountId: observerFeedback.providerAccountId },
              opts?.providerAccountId,
            ),
            threadId: body.message?.thread_ts,
            userId,
            insightId: observerFeedback.insightId,
            action: observerFeedback.action,
            localDay: observerFeedback.localDay,
          });
          if (outcome) {
            try {
              if (
                outcome.state === 'applied' &&
                outcome.observerDigestView &&
                messageTs
              ) {
                // One insight settled: rebuild the WHOLE digest from the updated
                // view (acted insight's buttons gone + marker; others still live).
                await app.client.chat.update({
                  channel: channelId,
                  ts: messageTs,
                  // Keep the full digest in the top-level `text` (screen readers read
                  // it, not blocks); receipt line first, then every insight.
                  text: `${outcome.receipt}\n\n${slackObserverDigestFallbackText(
                    outcome.observerDigestView,
                  )}`,
                  blocks: (() => {
                    // Preserve the account on the rebuilt buttons: prefer the
                    // parsed account (the original render carried it) so a later
                    // click still passes owner-route auth even when the
                    // handler-level opts.providerAccountId is unset.
                    const providerAccountId =
                      observerFeedback.providerAccountId ??
                      opts?.providerAccountId;
                    return slackObserverDigestBlocks(
                      outcome.observerDigestView,
                      {
                        ...(providerAccountId ? { providerAccountId } : {}),
                      },
                    );
                  })(),
                });
              } else {
                // denied / stale / invalid (non-owner, already-acted): private to
                // the clicker; the shared digest is untouched and still actionable.
                const text = outcome.replacementText
                  ? `${outcome.receipt}\n\n${outcome.replacementText}`
                  : outcome.receipt;
                await app.client.chat.postEphemeral({
                  channel: channelId,
                  user: userId,
                  text,
                });
              }
            } catch {
              // ignore receipt delivery failures
            }
          }
        },
      );
      return;
    }
    if (
      payload?.kind === 'memory_review_decision' &&
      typeof payload.reviewId === 'string' &&
      payload.reviewId.trim().length > 0 &&
      (payload.decision === 'approve' ||
        payload.decision === 'reject' ||
        payload.decision === 'edit') &&
      channelId &&
      userId
    ) {
      const messageTs = body.message?.ts;
      const outcome = await opts?.onMessageAction?.({
        kind: 'memory_review_decision',
        conversationJid: `sl:${channelId}`,
        ...providerAccountFromPayload(payload, opts?.providerAccountId),
        threadId: body.message?.thread_ts,
        userId,
        reviewId: payload.reviewId,
        decision: payload.decision as MemoryReviewActionDecision,
        label: '',
      });
      if (outcome) {
        try {
          if (isTerminalReviewOutcome(outcome) && messageTs) {
            // Rebuild the shared message as a receipt: Slack renders blocks, so
            // replace them (not just fallback text) to actually drop the buttons.
            await app.client.chat.update({
              channel: channelId,
              ts: messageTs,
              text: outcome.receipt,
              blocks: [
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: outcome.receipt },
                },
              ],
            });
          } else if (!isTerminalReviewOutcome(outcome)) {
            // denied / edit: private to the clicker; shared message untouched.
            const text = outcome.replacementText
              ? `${outcome.receipt}\n\n${outcome.replacementText}`
              : outcome.receipt;
            await app.client.chat.postEphemeral({
              channel: channelId,
              user: userId,
              text,
            });
          }
        } catch {
          // ignore receipt delivery failures
        }
      }
      return;
    }
    const brainReview = parseSlackBrainReview(payload);
    if (brainReview && channelId && userId) {
      const messageTs = body.message?.ts;
      const outcome = await opts?.onMessageAction?.({
        kind: 'brain_dream_review_decision',
        conversationJid: `sl:${channelId}`,
        ...providerAccountFromPayload(
          { providerAccountId: brainReview.providerAccountId },
          opts?.providerAccountId,
        ),
        threadId: body.message?.thread_ts,
        userId,
        reviewId: brainReview.reviewId,
        decision: brainReview.decision,
      });
      if (outcome) {
        try {
          if (isTerminalReviewOutcome(outcome) && messageTs) {
            // Terminal: replace blocks with a receipt section to drop buttons.
            await app.client.chat.update({
              channel: channelId,
              ts: messageTs,
              text: outcome.receipt,
              blocks: [
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: outcome.receipt },
                },
              ],
            });
          } else if (!isTerminalReviewOutcome(outcome)) {
            // denied (non-owner / lost race): private to the clicker.
            const text = outcome.replacementText
              ? `${outcome.receipt}\n\n${outcome.replacementText}`
              : outcome.receipt;
            await app.client.chat.postEphemeral({
              channel: channelId,
              user: userId,
              text,
            });
          }
        } catch {
          // ignore receipt delivery failures
        }
      }
      return;
    }
    if (
      !payload ||
      typeof payload.kind !== 'string' ||
      !SCHEDULER_MESSAGE_ACTION_KINDS.has(
        payload.kind as MessageActionAffordanceKind,
      ) ||
      typeof payload.jobId !== 'string' ||
      payload.jobId.trim().length === 0 ||
      !channelId ||
      !userId
    ) {
      return;
    }
    if (payload.kind === 'scheduler_run_now') {
      await opts?.onMessageAction?.({
        kind: 'scheduler_run_now',
        conversationJid: `sl:${channelId}`,
        ...providerAccountFromPayload(payload, opts?.providerAccountId),
        threadId: body.message?.thread_ts,
        userId,
        jobId: payload.jobId,
        runId: typeof payload.runId === 'string' ? payload.runId : null,
      });
      return;
    }
    try {
      await app.client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'Scheduler action buttons are visible hints only in this channel. Open the scheduler surface or use scheduler tools to run this action.',
      });
    } catch {
      // ignore callback feedback failures
    }
  });
}

function providerAccountFromPayload(
  payload: { providerAccountId?: unknown } | undefined,
  fallback?: string,
): { providerAccountId?: string } {
  if (typeof payload?.providerAccountId === 'string') {
    return { providerAccountId: payload.providerAccountId };
  }
  return fallback ? { providerAccountId: fallback } : {};
}
