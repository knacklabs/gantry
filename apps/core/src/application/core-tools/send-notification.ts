import type {
  ConversationRoute,
  MessageSendOptions,
} from '../../domain/types.js';
import { parseAgentThreadQueueKey } from '../../shared/thread-queue-key.js';

export interface NotificationDestination {
  name: string;
  jid: string;
  providerAccountId: string;
}

export const CLAIM_REVIEW_DELIVERY_FAILURE =
  'The claim review request could not be confirmed. Check the claim and evidence status before replying. Do not say that the claims team received it.';

export function notificationDestinations(input: {
  routes: Record<string, ConversationRoute>;
  sourceAgentFolder: string;
  providerAccountId?: string;
}): NotificationDestination[] {
  const destinations = new Map<string, NotificationDestination>();
  for (const [key, route] of Object.entries(input.routes)) {
    const parsed = parseAgentThreadQueueKey(key);
    const providerAccountId =
      parsed.providerAccountId ?? route.providerAccountId;
    if (
      route.folder !== input.sourceAgentFolder ||
      !providerAccountId ||
      (input.providerAccountId !== undefined &&
        providerAccountId !== input.providerAccountId) ||
      route.conversationKind !== 'channel' ||
      parsed.threadId ||
      !parsed.chatJid.startsWith('sl:')
    ) {
      continue;
    }
    destinations.set(`${providerAccountId}:${parsed.chatJid}`, {
      name: route.conversationDisplayName ?? route.name,
      jid: parsed.chatJid,
      providerAccountId,
    });
  }
  return [...destinations.values()];
}

export async function sendNotification(input: {
  destination: string;
  text: string;
  claimReview?: { claimId: string; sourceJid: string };
  reviewServiceUrl?: string;
  reviewChannelName?: string;
  fetcher?: typeof fetch;
  destinations: readonly NotificationDestination[];
  sendMessage: (
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ) => Promise<void>;
}): Promise<{ sent: true; destination: NotificationDestination }> {
  const resolve = (name: string): NotificationDestination => {
    const requested = name.trim().replace(/^#/, '').toLowerCase();
    const matches = input.destinations.filter(
      (destination) =>
        destination.name.toLowerCase() === requested ||
        destination.jid.toLowerCase() === requested ||
        destination.jid.slice(3).toLowerCase() === requested,
    );
    if (matches.length !== 1) {
      const available = [
        ...new Set(input.destinations.map((item) => `#${item.name}`)),
      ]
        .sort()
        .join(', ');
      throw new Error(
        `Requested destination "${name}" is unavailable or ambiguous. Available channels: ${available || 'none'}.`,
      );
    }
    return matches[0]!;
  };
  const destination = resolve(input.destination);
  const review = input.claimReview;
  const outcome = review ? resolve(review.sourceJid) : undefined;
  if (review && !/^CLM-[A-Z0-9-]{4,32}$/.test(review.claimId)) {
    throw new Error('Claim review requires a valid claim ID.');
  }
  if (outcome && outcome.providerAccountId !== destination.providerAccountId) {
    throw new Error('Claim review outcome must use the same channel account.');
  }
  let reviewEvidenceNotice = '';
  if (review && outcome) {
    const reviewChannel = (input.reviewChannelName ?? '')
      .replace(/^#/, '')
      .trim();
    if (
      !reviewChannel ||
      destination.name.toLowerCase() !== reviewChannel.toLowerCase() ||
      outcome.jid === destination.jid
    ) {
      throw new Error(
        'Claim review channels are not configured for this destination.',
      );
    }
    const serviceUrl = input.reviewServiceUrl ?? '';
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(serviceUrl)) {
      throw new Error('Claim review service is not configured.');
    }
    const lookup = await (input.fetcher ?? fetch)(
      `${serviceUrl}/claims/${encodeURIComponent(review.claimId)}`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!lookup.ok)
      throw new Error('Claim review requires an existing registered claim.');
    const data = (await lookup.json()) as {
      claim?: { status?: string; reviewCardPostedAt?: string };
      evidence?: Array<{ documentType?: string }>;
    };
    const types = new Set(
      (data.evidence ?? []).map((item) => item.documentType),
    );
    const hasRepairEstimate = types.has('repair_estimate');
    const hasClaimForm = types.has('incident_report');
    if (
      data.claim?.status !== 'submitted_for_review' ||
      !types.has('damage_photo') ||
      (!hasRepairEstimate && !hasClaimForm)
    ) {
      throw new Error(
        'Claim review requires a submitted claim, damage image, and either a repair estimate or claim form.',
      );
    }
    if (data.claim.reviewCardPostedAt)
      throw new Error('A review card has already been sent for this claim.');
    if (!hasRepairEstimate) {
      reviewEvidenceNotice =
        '\n\nEvidence note: Repair estimate not received. Claim form details are unverified; compare its policy, vehicle, and incident details with the registered claim during assessment.';
    }
  }
  const message = review
    ? `${input.text.trim()}${reviewEvidenceNotice}\n\nInternal review: “Accept for assessment” means the claim can proceed to further assessment. It is not final claim approval or a payout decision.`
    : input.text;
  await input.sendMessage(destination.jid, message, {
    providerAccountId: destination.providerAccountId,
    ...(review && outcome
      ? {
          actionAffordances: [
            {
              kind: 'claim_review_decision' as const,
              label: 'Accept for assessment',
              claimId: review.claimId,
              outcomeJid: outcome.jid,
              decision: 'approve' as const,
            },
            {
              kind: 'claim_review_decision' as const,
              label: 'Decline claim',
              claimId: review.claimId,
              outcomeJid: outcome.jid,
              decision: 'decline' as const,
            },
          ],
        }
      : {}),
  });
  if (review) {
    const serviceUrl = input.reviewServiceUrl ?? '';
    const marked = await (input.fetcher ?? fetch)(
      `${serviceUrl}/claims/${encodeURIComponent(review.claimId)}/review-card-sent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!marked.ok)
      throw new Error(
        'Review card was delivered, but its delivery could not be recorded. Check the channel before retrying.',
      );
  }
  return { sent: true, destination };
}
