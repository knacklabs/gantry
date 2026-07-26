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
 * Buttons come off the message once the review can no longer move: applied
 * (settled), stale (withdrawn) or invalid (gone). denied keeps them — another
 * approver may act — and the edit prompt (needs_input) keeps them so the
 * reviewer can still approve/reject after replying. An explicit clearActions
 * from the handler wins over this default.
 */
function reviewActionsCleared(outcome: MessageActionOutcome): boolean {
  if (typeof outcome.clearActions === 'boolean') return outcome.clearActions;
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
      if (outcome && messageTs) {
        const text = outcome.replacementText
          ? `${outcome.receipt}\n\n${outcome.replacementText}`
          : outcome.receipt;
        try {
          await app.client.chat.update({
            channel: body.channel.id,
            ts: messageTs,
            text,
            ...(reviewActionsCleared(outcome) ? { blocks: [] } : {}),
          });
        } catch {
          // ignore receipt update failures
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
