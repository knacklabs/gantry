import type {
  MemoryReviewActionDecision,
  MessageActionAffordanceKind,
  MessageActionOutcome,
  OnMessageAction,
} from '../../domain/types.js';

const SCHEDULER_MESSAGE_ACTION_KINDS = new Set<MessageActionAffordanceKind>([
  'scheduler_run_now',
  'scheduler_pause_job',
]);

type SlackAppLike = {
  action: (name: string, handler: (args: any) => Promise<void>) => void;
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
  app.action('gantry_message_action', async (args: any) => {
    await args.ack();
    const action = args.action as { value?: string };
    const body = args.body as {
      channel?: { id?: string };
      message?: { thread_ts?: string; ts?: string };
      user?: { id?: string };
    };
    let payload:
      | {
          kind?: unknown;
          jobId?: unknown;
          runId?: unknown;
          reviewId?: unknown;
          decision?: unknown;
          providerAccountId?: unknown;
        }
      | undefined;
    try {
      payload = action.value ? JSON.parse(action.value) : undefined;
    } catch {
      return;
    }
    if (
      payload?.kind === 'memory_review_decision' &&
      typeof payload.reviewId === 'string' &&
      payload.reviewId.trim().length > 0 &&
      (payload.decision === 'approve' ||
        payload.decision === 'reject' ||
        payload.decision === 'edit') &&
      body.channel?.id &&
      body.user?.id
    ) {
      const messageTs = body.message?.ts;
      const outcome = await opts?.onMessageAction?.({
        kind: 'memory_review_decision',
        conversationJid: `sl:${body.channel.id}`,
        ...providerAccountFromPayload(payload, opts?.providerAccountId),
        threadId: body.message?.thread_ts,
        userId: body.user.id,
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
              channel: body.channel.id,
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
              channel: body.channel.id,
              user: body.user.id,
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
      !body.channel?.id ||
      !body.user?.id
    ) {
      return;
    }
    if (payload.kind === 'scheduler_run_now') {
      await opts?.onMessageAction?.({
        kind: 'scheduler_run_now',
        conversationJid: `sl:${body.channel.id}`,
        ...providerAccountFromPayload(payload, opts?.providerAccountId),
        threadId: body.message?.thread_ts,
        userId: body.user.id,
        jobId: payload.jobId,
        runId: typeof payload.runId === 'string' ? payload.runId : null,
      });
      return;
    }
    try {
      await app.client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
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
