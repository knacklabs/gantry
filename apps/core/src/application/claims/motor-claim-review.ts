import type { ConversationRoute } from '../../domain/types.js';
import type { MessageActionOutcome } from '../../domain/message-actions.js';
import { parseAgentThreadQueueKey } from '../../shared/thread-queue-key.js';

type DecisionResponse = {
  claim?: { claimId?: string; status?: string };
  decision?: {
    decisionId?: string;
    decision?: string;
    reason?: string;
    notificationStatus?: string;
  };
  error?: string;
};

export async function decideMotorClaimReview(input: {
  claimId: string;
  decision: 'approve' | 'decline';
  reason?: string;
  userId: string;
  providerAccountId?: string;
  sourceAgentFolder: string;
  reviewJid: string;
  outcomeJid: string;
  routes: Record<string, ConversationRoute>;
  reviewChannelName: string;
  sendMessage: (
    jid: string,
    text: string,
    providerAccountId?: string,
  ) => Promise<void>;
  serviceUrl: string;
  fetcher?: typeof fetch;
}): Promise<MessageActionOutcome> {
  const reviewName = input.reviewChannelName.replace(/^#/, '').trim();
  const bound = (
    jid: string,
    name: string | undefined,
    providerAccountId?: string,
    channelOnly = false,
  ) =>
    Object.entries(input.routes).filter(([key, route]) => {
      const parsed = parseAgentThreadQueueKey(key);
      return (
        parsed.chatJid === jid &&
        !parsed.threadId &&
        route.folder === input.sourceAgentFolder &&
        (!channelOnly || route.conversationKind === 'channel') &&
        (!providerAccountId ||
          (parsed.providerAccountId ?? route.providerAccountId) ===
            providerAccountId) &&
        (!name ||
          (route.conversationDisplayName ?? route.name).toLowerCase() ===
            name.toLowerCase())
      );
    });
  const outcomeAccounts = new Set(
    bound(input.outcomeJid, undefined)
      .map(
        ([key, route]) =>
          parseAgentThreadQueueKey(key).providerAccountId ??
          route.providerAccountId,
      )
      .filter((account): account is string => Boolean(account)),
  );
  const outcomeProviderAccountId =
    outcomeAccounts.size === 1
      ? outcomeAccounts.values().next().value
      : undefined;
  if (
    !reviewName ||
    bound(input.reviewJid, reviewName, input.providerAccountId, true).length ===
      0 ||
    !outcomeProviderAccountId ||
    input.outcomeJid === input.reviewJid
  ) {
    return {
      state: 'denied',
      receipt: 'This claim review card is not configured for these channels.',
    };
  }
  if (input.decision === 'decline' && !input.reason?.trim()) {
    return {
      state: 'needs_input',
      receipt: 'Enter a reason before declining this claim.',
    };
  }
  const serviceUrl = input.serviceUrl;
  if (!serviceUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(serviceUrl)) {
    return { state: 'denied', receipt: 'Claim review service is unavailable.' };
  }
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `${serviceUrl}/claims/${encodeURIComponent(input.claimId)}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: input.decision,
          actorId: input.userId,
          reason: input.reason?.trim() ?? '',
          requestId: `review-${input.claimId}-${input.decision}`,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return {
      state: 'denied',
      receipt: 'Claim review service is unavailable. Please retry.',
    };
  }
  const result = (await response.json().catch(() => ({}))) as DecisionResponse;
  if (!response.ok || !result.claim?.claimId || !result.decision?.decisionId) {
    const conflictReceipt =
      result.error === 'CLAIM_REVIEW_CARD_NOT_POSTED'
        ? `Claim ${input.claimId} review request was not recorded. No decision was made; ask an operator to reconcile the review card.`
        : result.error === 'CLAIM_EVIDENCE_INCOMPLETE'
          ? `Claim ${input.claimId} is missing required evidence. No decision was made.`
          : result.error === 'CLAIM_NOT_AWAITING_REVIEW'
            ? `Claim ${input.claimId} is not awaiting review. Check its current status before deciding.`
            : result.error === 'IDEMPOTENCY_CONFLICT'
              ? `Claim ${input.claimId} decision conflicts with an earlier attempt. Check its current status before retrying.`
              : `Claim ${input.claimId} could not be decided. Check its current status before retrying.`;
    return {
      state: response.status === 409 ? 'stale' : 'denied',
      receipt:
        response.status === 409
          ? conflictReceipt
          : 'The claim decision could not be saved. Please retry.',
    };
  }
  const label =
    input.decision === 'approve'
      ? 'accepted for further assessment'
      : 'declined in internal review';
  const reason =
    input.decision === 'decline' ? ` Reason: ${result.decision.reason}.` : '';
  const receipt = `Claim ${input.claimId} ${label} by <@${input.userId}>.${reason}`;
  if (result.decision.notificationStatus !== 'sent') {
    try {
      await input.sendMessage(
        input.outcomeJid,
        `Claim ${input.claimId} ${label}.${reason} This is an internal review decision, not a payout confirmation.`,
        outcomeProviderAccountId,
      );
      const mark = await fetcher(
        `${serviceUrl}/decisions/${encodeURIComponent(result.decision.decisionId)}/notification-sent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!mark.ok) throw new Error('notification mark failed');
    } catch {
      return {
        state: 'denied',
        receipt: `${receipt} The customer-channel notification is still pending. Click the same decision again to retry.`,
      };
    }
  }
  return { state: 'applied', receipt };
}
