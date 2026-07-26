import type { ObserverActivationStatus } from '../../config/settings/observer-activation.js';
import type { ObserverDigestMessageView } from '../../domain/observer-digest-view.js';
import { markObserverDigestInsight } from '../../domain/observer-digest-view.js';
import type {
  ObserverInsightType,
  ObserverOwnerActionInsight,
  ObserverOwnerActionResult,
} from '../../domain/ports/observer-insights.js';
import { getRuntimeSettingsForConfig } from '../../config/index.js';
import { resolveVerifiedObserverActivationStatus } from '../../config/settings/observer-activation.js';
import { getRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import { DEFAULT_MEMORY_APP_ID } from '../../memory/app-memory-boundaries.js';
import { nowIso } from '../../shared/time/datetime.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { ChannelWiring } from './channel-wiring-types.js';
import type { ObserverFeedbackAction } from '../../domain/message-actions.js';
import type {
  MessageActionOutcome,
  ObserverFeedbackMessageActionInput,
} from '../../domain/types.js';

/**
 * Execute a channel-initiated observer digest feedback action.
 *
 * OWNER-ONLY (stricter than memory-review's same-channel control approver): the
 * digest is a private owner DM, so ANOTHER control approver must NOT be able to
 * resolve the owner's insights. The channel supplies an AUTHENTICATED provider
 * identity + conversation; it never supplies authority. This handler:
 *   1. requires a provider-authenticated userId,
 *   2. resolves the CURRENT verified observer owner route and requires the
 *      callback userId + conversation route to match it exactly, and
 *   3. requires the insight to be owner-scoped and delivered on that same route.
 * Only then does it hand the mutation to the trusted executor (applyOwnerAction);
 * the terminal/idempotency veto lives in that DB path, not here.
 */

// Locked Phase-2 owner-action parameters.
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SUPPRESS_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const SUPPRESS_THRESHOLD = 2;

const OWNER_ONLY_RECEIPT = 'Only the digest owner can act on these insights.';
const NOT_FOUND_RECEIPT = 'This insight could not be found.';
const STALE_RECEIPT = 'This insight is no longer open.';
const FAILED_RECEIPT = 'This insight could not be updated.';

export interface ObserverFeedbackMessageActionDeps {
  appId: string;
  nowIso: () => string;
  // The CURRENT DB-verified owner route (resolveVerifiedObserverActivationStatus);
  // an unverified/unconfigured owner yields a status WITHOUT `owner`.
  resolveVerifiedOwner: () => Promise<ObserverActivationStatus>;
  findInsightForOwnerAction: (input: {
    appId: string;
    recipient: string;
    insightId: string;
  }) => Promise<ObserverOwnerActionInsight | null>;
  applyOwnerAction: (input: {
    appId: string;
    recipient: string;
    actorUserId: string;
    insightId: string;
    action: ObserverFeedbackAction;
    nowIso: string;
    snoozeMs: number;
    suppressMs: number;
    suppressThreshold: number;
  }) => Promise<ObserverOwnerActionResult>;
  // Best-effort re-load of the durable digest view for the EXACT delivery this
  // button belongs to, keyed by the callback's own (recipient, localDay) — the
  // token self-identifies its digest, so an insight that also rode a later digest
  // can never resolve against the wrong one. Null when it cannot be recovered.
  loadReservationView: (input: {
    recipient: string;
    localDay: string;
  }) => Promise<ObserverDigestMessageView | null>;
  // The owner's settled action per insight, so the rebuild re-marks EVERY
  // already-acted insight in the digest — not just the one just clicked.
  listOwnerActions: (input: {
    appId: string;
    recipient: string;
    insightIds: string[];
  }) => Promise<Map<string, ObserverFeedbackAction>>;
  warn: (context: Record<string, unknown>, message: string) => void;
}

function receiptForAction(
  action: ObserverFeedbackAction,
  insightType: ObserverInsightType,
): string {
  switch (action) {
    case 'resolve':
      return 'Insight resolved.';
    case 'dismiss':
      return 'Insight dismissed.';
    case 'snooze':
      return 'Insight snoozed for 30 days.';
    case 'less_like_this':
      return `We'll show fewer ${insightType.replace(/_/g, ' ')} insights.`;
  }
}

export async function handleObserverFeedbackAction(
  deps: ObserverFeedbackMessageActionDeps,
  action: ObserverFeedbackMessageActionInput,
): Promise<MessageActionOutcome> {
  // Step 1: a provider-authenticated user is required — identity in, never authority.
  if (!action.userId) {
    return {
      state: 'invalid',
      receipt: 'Missing an authenticated user for this insight action.',
    };
  }
  try {
    // Step 2: the callback identity + route MUST be the current verified owner DM.
    const activation = await deps.resolveVerifiedOwner();
    if (!('owner' in activation)) {
      return { state: 'denied', receipt: OWNER_ONLY_RECEIPT };
    }
    const owner = activation.owner;
    if (
      action.userId !== owner.recipient ||
      action.conversationJid !== owner.conversationJid ||
      (action.providerAccountId ?? '') !== owner.providerAccountId
    ) {
      return { state: 'denied', receipt: OWNER_ONLY_RECEIPT };
    }
    // Step 3: the insight must be owned by this owner AND delivered on this route.
    const found = await deps.findInsightForOwnerAction({
      appId: deps.appId,
      recipient: owner.recipient,
      insightId: action.insightId,
    });
    if (
      !found ||
      (found.conversationJid ?? '') !== action.conversationJid ||
      (found.providerAccountId ?? '') !== (action.providerAccountId ?? '')
    ) {
      return { state: 'invalid', receipt: NOT_FOUND_RECEIPT };
    }
    const result = await deps.applyOwnerAction({
      appId: deps.appId,
      recipient: owner.recipient,
      actorUserId: action.userId,
      insightId: action.insightId,
      action: action.action,
      nowIso: deps.nowIso(),
      snoozeMs: SNOOZE_MS,
      suppressMs: SUPPRESS_MS,
      suppressThreshold: SUPPRESS_THRESHOLD,
    });
    if (result.outcome === 'stale') {
      return { state: 'stale', receipt: STALE_RECEIPT };
    }
    if (result.outcome === 'invalid') {
      return { state: 'invalid', receipt: NOT_FOUND_RECEIPT };
    }
    // Applied: rebuild the whole digest view from the durable feedback truth so
    // EVERY already-acted insight shows its marker with buttons removed (not just
    // the one just clicked), while un-acted insights stay actionable.
    const outcome: MessageActionOutcome = {
      state: 'applied',
      receipt: receiptForAction(action.action, found.insight.insightType),
    };
    try {
      const view = await deps.loadReservationView({
        recipient: owner.recipient,
        localDay: action.localDay,
      });
      if (view) {
        const owned = await deps.listOwnerActions({
          appId: deps.appId,
          recipient: owner.recipient,
          insightIds: view.insights.map((insight) => insight.insightId),
        });
        outcome.observerDigestView = view.insights.reduce(
          (rebuilt, insight) => {
            const acted = owned.get(insight.insightId);
            return acted
              ? markObserverDigestInsight(rebuilt, insight.insightId, acted)
              : rebuilt;
          },
          view,
        );
      } else {
        deps.warn(
          { insightId: action.insightId },
          'observer feedback applied but digest view could not be re-loaded; channel keeps the message unchanged',
        );
      }
    } catch (err) {
      deps.warn(
        {
          insightId: action.insightId,
          error: err instanceof Error ? err.message : String(err),
        },
        'observer feedback applied but digest view re-load threw; channel keeps the message unchanged',
      );
    }
    return outcome;
  } catch {
    // Any lookup/DB failure inside the boundary is a controlled invalid, never an
    // unhandled rejection escaping into the channel adapter.
    return { state: 'invalid', receipt: FAILED_RECEIPT };
  }
}

export function registerRuntimeObserverFeedbackMessageAction(
  channelWiring: ChannelWiring,
): void {
  const deps: ObserverFeedbackMessageActionDeps = {
    appId: DEFAULT_MEMORY_APP_ID,
    nowIso: () => nowIso(),
    resolveVerifiedOwner: () =>
      resolveVerifiedObserverActivationStatus(
        getRuntimeSettingsForConfig(),
        DEFAULT_MEMORY_APP_ID,
        getRuntimeStorage().repositories.conversations,
      ),
    findInsightForOwnerAction: (input) =>
      getRuntimeStorage().repositories.observerInsights.findInsightForOwnerAction(
        input,
      ),
    applyOwnerAction: (input) =>
      getRuntimeStorage().repositories.observerInsights.applyOwnerAction(input),
    // Re-load the durable digest view by the callback's own (recipient, localDay)
    // — the button carries the day it was rendered for, so this pins to the exact
    // delivery and is timezone-stable (no surfacedAt/timezone recompute).
    loadReservationView: async ({ recipient, localDay }) => {
      const reservation =
        await getRuntimeStorage().repositories.observerInsights.findDigestReservation(
          { appId: DEFAULT_MEMORY_APP_ID, recipient, localDay },
        );
      return reservation?.renderedView ?? null;
    },
    listOwnerActions: (input) =>
      getRuntimeStorage().repositories.observerInsights.listOwnerActionsForInsights(
        input,
      ),
    warn: (context, message) => logger.warn(context, message),
  };
  channelWiring.setObserverFeedbackMessageActionHandler((action) =>
    handleObserverFeedbackAction(deps, action),
  );
}
