import { createHash, randomUUID } from 'node:crypto';

import { OutboundDeliveryService } from '../../application/outbound-delivery/outbound-delivery-service.js';
import type { BrainReviewNotifyGateway } from '../../brain/brain-dream-review-notify.js';
import type { OutboundDeliveryProfile } from '../../domain/outbound-delivery/planner.js';
import type { OutboundDeliveryRepository } from '../../domain/ports/repositories.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  BRAIN_REVIEW_PROFILE_ID,
  canonicalThreadIdFor,
  resolveDurableOutboundTarget,
} from './runtime-services-destination-hints.js';

// Shared brain-review notify wiring, used by BOTH the runtime (registers the
// profile in its shared OutboundDeliveryService + sets the module gateway) and
// the CLI re-notify command (builds its own service over the same repo). Keeping
// the profile + enqueue closure in one place means the durable payload shape and
// idempotency key match wherever a review notification is (re)enqueued.

// Single-part send whose rendered card view (T5/T6) rides in the item
// providerPayload so recovery dispatch renders native buttons.
export const brainReviewOutboundProfile: OutboundDeliveryProfile = {
  profileId: BRAIN_REVIEW_PROFILE_ID,
  plan: (input) => {
    const brainReviewView =
      input.metadata &&
      typeof input.metadata === 'object' &&
      'brainReviewView' in input.metadata
        ? (input.metadata.brainReviewView as unknown)
        : undefined;
    return {
      parts: [
        {
          canonicalText: input.text,
          ...(brainReviewView !== undefined
            ? { providerPayload: { brainReviewView } }
            : {}),
        },
      ],
      canonicalFinalText: input.text,
    };
  },
};

// Standalone single-profile OutboundDeliveryService over a repository — for the
// CLI re-notify command, which has no runtime OutboundDeliveryService. The
// running runtime's outbound recovery loop sends whatever this enqueues.
export function createBrainReviewOutboundService(
  repository: OutboundDeliveryRepository,
): OutboundDeliveryService {
  return new OutboundDeliveryService({
    repository,
    profiles: {
      resolve: (id) =>
        id === BRAIN_REVIEW_PROFILE_ID ? brainReviewOutboundProfile : undefined,
    },
    now: () => nowIso(),
    createId: () => randomUUID(),
    hashSha256Hex: (value) =>
      createHash('sha256').update(value, 'utf8').digest('hex'),
  });
}

// The gateway enqueue closure over a given OutboundDeliveryService: enqueue the
// owner-DM card under the brain-review profile, idempotent on
// `brain-review:<reviewId>` (exactly one notification per review). The outbound
// recovery loop sends it and re-renders the native buttons from the carried view.
export function brainReviewNotifyGatewayFor(
  outboundDeliveryService: OutboundDeliveryService,
): BrainReviewNotifyGateway {
  return {
    enqueue: async (input) => {
      const target = resolveDurableOutboundTarget({
        defaultAppId: input.appId,
        jid: input.conversationJid,
        providerAccountId: input.providerAccountId,
      });
      const result = await outboundDeliveryService.enqueue({
        appId: target.appId as never,
        conversationId: target.conversationId as never,
        threadId: canonicalThreadIdFor({
          jid: input.conversationJid,
          threadId: input.threadId ?? undefined,
          providerAccountId: input.providerAccountId,
        }) as never,
        profileId: BRAIN_REVIEW_PROFILE_ID,
        idempotencyKey: input.idempotencyKey,
        text: input.text,
        metadata: {
          destinationJid: input.conversationJid,
          brainReview: true,
          brainReviewView: input.brainReviewView,
        },
      });
      return { outboundDeliveryId: result.delivery.id };
    },
  };
}
