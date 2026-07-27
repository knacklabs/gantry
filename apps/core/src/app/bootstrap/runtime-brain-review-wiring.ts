import { getRuntimeSettingsForConfig } from '../../config/index.js';
import { resolveVerifiedOwnerRoute } from '../../config/settings/observer-activation.js';
import { getRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import { DEFAULT_MEMORY_APP_ID } from '../../memory/app-memory-boundaries.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { executeBrainDreamReviewDecision } from '../../brain/brain-dream-review-executor.js';
import {
  handleBrainDreamReviewAction,
  type BrainReviewMessageActionDeps,
} from './runtime-brain-review-message-action.js';
import type { ChannelWiring } from './channel-wiring-types.js';

// Composition seam: binds the owner-only brain-review decision handler to the
// live config + storage adapters. The verified-owner resolver is NOT gated on
// Observer being enabled (resolveVerifiedOwnerRoute), so destructive-proposal
// reviews work even when Observer is off.
export function registerRuntimeBrainDreamReviewMessageAction(
  channelWiring: ChannelWiring,
): void {
  const deps: BrainReviewMessageActionDeps = {
    // Single-app by design, same as observer + memory review: the brain dream
    // batch (runScheduledBrainDreaming), the T6 owner-DM notification, and this
    // decision handler ALL key DEFAULT_MEMORY_APP_ID, so a review's creation
    // scope always matches the handler's verification scope. If brain ever
    // becomes multi-app, thread the runtime app id here (and into the batch) so
    // they can't silently mismatch — the e2e asserts handler.appId == review.appId.
    appId: DEFAULT_MEMORY_APP_ID,
    resolveVerifiedOwner: () =>
      resolveVerifiedOwnerRoute(
        getRuntimeSettingsForConfig(),
        DEFAULT_MEMORY_APP_ID,
        getRuntimeStorage().repositories.conversations,
      ),
    executeDecision: (input) =>
      executeBrainDreamReviewDecision({
        db: getRuntimeStorage().service.db,
        reviews: getRuntimeStorage().repositories.brainDreamReviews,
        appId: input.appId,
        reviewId: input.reviewId,
        decision: input.decision,
        reviewer: input.reviewer,
      }),
    warn: (context, message) => logger.warn(context, message),
  };
  channelWiring.setBrainDreamReviewMessageActionHandler((action) =>
    handleBrainDreamReviewAction(deps, action),
  );
}
