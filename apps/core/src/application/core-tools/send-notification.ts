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

export interface NotificationOrigin {
  jid: string;
  providerAccountId: string;
}

export const CLAIM_REVIEW_DELIVERY_FAILURE =
  'The claim review request could not be confirmed. Check the claim and evidence status before replying. Do not say that the claims team received it.';

const CLAIM_REVIEW_ADVISORY_LABELS = [
  'Why this was sent for human review',
  "MotoBuddy's view",
  'Reason',
  'Confidence',
  'Attention needed',
] as const;

function ensureClaimReviewAdvisory(text: string): string {
  const concernPattern =
    /mismatch|inconsisten|unreadable|missing|uncertain|discrepanc|could not|not received|sample|invalid/i;
  const hasEvidenceConcern = concernPattern.test(text);
  const fallbackView = hasEvidenceConcern
    ? 'Decline claim'
    : 'Accept for assessment';
  const normalizedLines = text.trim().split(/\r?\n/);
  const existingViewIndex = normalizedLines.findIndex((line) =>
    line.trimStart().toLowerCase().startsWith("motobuddy's view:"),
  );
  if (existingViewIndex >= 0) {
    const currentView = normalizedLines[existingViewIndex]!.toLowerCase();
    if (
      !currentView.includes('accept for assessment') &&
      !currentView.includes('decline claim')
    ) {
      normalizedLines[existingViewIndex] = `MotoBuddy's view: ${fallbackView}`;
    }
  }
  const normalizedText = normalizedLines.join('\n');
  const lines = normalizedLines.map((line) => line.trimStart().toLowerCase());
  const hasLabel = (label: (typeof CLAIM_REVIEW_ADVISORY_LABELS)[number]) =>
    lines.some((line) => line.startsWith(`${label.toLowerCase()}:`));
  const defaults: Record<
    (typeof CLAIM_REVIEW_ADVISORY_LABELS)[number],
    string
  > = {
    'Why this was sent for human review': hasEvidenceConcern
      ? 'The claim reached submitted-for-review after the required evidence was stored. It is complete enough for a human decision, but the evidence inconsistency requires human judgment.'
      : 'The claim reached submitted-for-review after the required evidence was stored, making it ready for a human decision.',
    "MotoBuddy's view": fallbackView,
    Reason: hasEvidenceConcern
      ? 'The evidence contains a material inconsistency, so I would not accept the claim for assessment without the reviewer resolving it.'
      : 'The registered policy and required evidence support continued assessment, subject to human review.',
    Confidence: 'Medium',
    'Attention needed': hasEvidenceConcern
      ? 'Compare the evidence with the registered policy, vehicle, incident, and damage details.'
      : 'Verify coverage, exclusions, and evidence before deciding.',
  };
  const missingLines = CLAIM_REVIEW_ADVISORY_LABELS.filter(
    (label) => !hasLabel(label),
  ).map((label) => `${label}: ${defaults[label]}`);
  const disclaimer =
    "This is MotoBuddy's non-binding view. The final decision belongs to the human reviewer.";
  const futureDecisionNotice =
    'I will store your response for future decisions.';
  const additions = [...missingLines];
  if (!normalizedText.toLowerCase().includes(disclaimer.toLowerCase())) {
    additions.push(disclaimer);
  }
  if (
    !normalizedText.toLowerCase().includes(futureDecisionNotice.toLowerCase())
  ) {
    additions.push(futureDecisionNotice);
  }
  return additions.length > 0
    ? `${normalizedText}\n\n${additions.join('\n')}`
    : normalizedText;
}

function formatClaimReviewMessage(input: {
  text: string;
  evidenceNotice: string;
}): string {
  const futureDecisionNotice =
    'I will store your response for future decisions.';
  const nonBindingNotice =
    "This is MotoBuddy's non-binding view. The final decision belongs to the human reviewer.";
  const lines = input.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        Boolean(line) &&
        line.toLowerCase() !== futureDecisionNotice.toLowerCase() &&
        line.toLowerCase() !== nonBindingNotice.toLowerCase(),
    );
  const take = (...labels: string[]): string | undefined => {
    const index = lines.findIndex((line) =>
      labels.some((label) =>
        line.toLowerCase().startsWith(`${label.toLowerCase()}:`),
      ),
    );
    if (index < 0) return undefined;
    const [line] = lines.splice(index, 1);
    return line?.slice(line.indexOf(':') + 1).trim() || undefined;
  };
  const claim = take('Claim', 'Claim ID');
  const policy = take('Policy', 'Policy ID');
  const incident = take('Incident');
  const evidence = take('Evidence count', 'Evidence');
  const estimate = take(
    'Unverified estimate total',
    'Unverified provisional estimate total',
  );
  take('Why this was sent for human review');
  const view = take("MotoBuddy's view");
  const reason = take('Reason', 'Review reason');
  const confidence = take('Confidence');
  take('Attention needed');
  const sections = [':clipboard: **Motor Claim Review**'];
  const facts = [
    claim ? `• **Claim:** \`${claim}\`` : undefined,
    policy ? `• **Policy:** \`${policy}\`` : undefined,
    incident ? `• **Incident:** ${incident}` : undefined,
    evidence ? `• **Evidence:** ${evidence}` : undefined,
    estimate ? `• **Estimate:** ${estimate} (unverified)` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (facts.length > 0)
    sections.push(`:page_facing_up: **Claim details**\n${facts.join('\n')}`);
  const advisory = [
    view
      ? `**View:** **${view}**${confidence ? ` — **${confidence} confidence.**` : ''}`
      : undefined,
    reason ? `**Reason:** ${reason}` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (advisory.length > 0) {
    sections.push(
      `:robot_face: **MotoBuddy advisory**\n${advisory.join('\n')}`,
    );
  }
  const evidenceNotice = input.evidenceNotice
    .trim()
    .replace(/^Evidence note:\s*/i, '');
  if (evidenceNotice)
    sections.push(`:warning: **Evidence note**\n${evidenceNotice}`);
  sections.push(futureDecisionNotice);
  return sections.join('\n\n');
}

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

export function notificationOrigin(input: {
  routes: Record<string, ConversationRoute>;
  sourceAgentFolder: string;
  sourceJid: string;
  providerAccountId?: string;
}): NotificationOrigin | undefined {
  const origins = new Map<string, NotificationOrigin>();
  for (const [key, route] of Object.entries(input.routes)) {
    const parsed = parseAgentThreadQueueKey(key);
    const providerAccountId =
      parsed.providerAccountId ?? route.providerAccountId;
    if (
      parsed.chatJid !== input.sourceJid ||
      parsed.threadId ||
      route.folder !== input.sourceAgentFolder ||
      !providerAccountId ||
      (input.providerAccountId !== undefined &&
        providerAccountId !== input.providerAccountId)
    ) {
      continue;
    }
    origins.set(providerAccountId, {
      jid: parsed.chatJid,
      providerAccountId,
    });
  }
  return origins.size === 1 ? origins.values().next().value : undefined;
}

export function notificationAccessForAgent(input: {
  routes: Record<string, ConversationRoute>;
  sourceAgentFolder: string;
  sourceJid: string;
  providerAccountId?: string;
}): {
  notificationDestinations: NotificationDestination[];
  notificationOrigin: NotificationOrigin | undefined;
} {
  return {
    notificationDestinations: notificationDestinations({
      routes: input.routes,
      sourceAgentFolder: input.sourceAgentFolder,
      ...(input.sourceJid.startsWith('sl:') && input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
    }),
    notificationOrigin: notificationOrigin(input),
  };
}

export async function sendNotification(input: {
  destination: string;
  text: string;
  claimReview?: { claimId: string; origin?: NotificationOrigin };
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
  const outcome = review?.origin;
  if (review && !/^CLM-[A-Z0-9-]{4,32}$/.test(review.claimId)) {
    throw new Error('Claim review requires a valid claim ID.');
  }
  if (review && (!outcome?.jid || !outcome.providerAccountId)) {
    throw new Error('Claim review requires a bound originating conversation.');
  }
  const notificationText = review
    ? ensureClaimReviewAdvisory(input.text)
    : input.text;
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
    ? formatClaimReviewMessage({
        text: notificationText,
        evidenceNotice: reviewEvidenceNotice,
      })
    : notificationText;
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
