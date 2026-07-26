import { getRuntimeSettingsForConfig } from '../../config/index.js';
import { resolveVerifiedObserverActivationStatus } from '../../config/settings/observer-activation.js';
import { getRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import { DEFAULT_MEMORY_APP_ID } from '../../memory/app-memory-boundaries.js';
import { nowIso } from '../../shared/time/datetime.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { ObserverVerifiedOwner } from '../../domain/ports/observer-insights.js';
import {
  handleObserverFeedbackAction,
  type ObserverFeedbackMessageActionDeps,
} from './runtime-observer-feedback-message-action.js';
import type { ChannelWiring } from './channel-wiring-types.js';

// Composition seam: binds the owner-only observer feedback handler to the live
// config + storage adapters. Kept out of the handler file so that file stays
// domain/shared-only; this file is the same capped bootstrap-wiring boundary as
// the sibling register-* helpers.
async function resolveVerifiedOwner(): Promise<ObserverVerifiedOwner> {
  const activation = await resolveVerifiedObserverActivationStatus(
    getRuntimeSettingsForConfig(),
    DEFAULT_MEMORY_APP_ID,
    getRuntimeStorage().repositories.conversations,
  );
  return 'owner' in activation ? { owner: activation.owner } : {};
}

export function registerRuntimeObserverFeedbackMessageAction(
  channelWiring: ChannelWiring,
): void {
  const deps: ObserverFeedbackMessageActionDeps = {
    appId: DEFAULT_MEMORY_APP_ID,
    nowIso: () => nowIso(),
    resolveVerifiedOwner,
    findInsightForOwnerAction: (input) =>
      getRuntimeStorage().repositories.observerInsights.findInsightForOwnerAction(
        input,
      ),
    applyOwnerAction: (input) =>
      getRuntimeStorage().repositories.observerInsights.applyOwnerAction(input),
    // Resolve the exact delivery + its durable view by the callback's own
    // (recipient, localDay) — the button carries the day it was rendered for, so
    // this pins to the exact delivery and is timezone-stable (no surfacedAt
    // recompute). The delivery id scopes the mutation + rebuild.
    loadReservation: async ({ recipient, localDay }) => {
      const reservation =
        await getRuntimeStorage().repositories.observerInsights.findDigestReservation(
          { appId: DEFAULT_MEMORY_APP_ID, recipient, localDay },
        );
      return reservation
        ? { deliveryId: reservation.id, view: reservation.renderedView }
        : null;
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
