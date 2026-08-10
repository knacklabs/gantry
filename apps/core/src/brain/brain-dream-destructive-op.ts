import { nowIso } from '../shared/time/datetime.js';
import { intakeDestructiveDreamOp } from './brain-dream-review-intake.js';
import type { BrainDreamReviewRepository } from './brain-dream-review-repository.js';
import type { BrainReviewNotifier } from './brain-dream-review-notify.js';
import type { BrainRepository } from './brain-repository.js';

export function requireBrainDreamReviews(
  reviews: BrainDreamReviewRepository | undefined,
): BrainDreamReviewRepository {
  if (!reviews) throw new Error('Brain dreaming requires a review repository.');
  return reviews;
}

export function journalObserverDestructiveOp(action: string): {
  outcome: 'proposed';
  reason: string;
} {
  return {
    outcome: 'proposed',
    reason: `${action} was journaled by observer dreaming without review`,
  };
}

// retire_page is deferred in v1 (no review). Every other destructive op runs
// through validation + snapshot + review creation. No mutation is executed here.
export async function handleDestructiveOp(input: {
  reviews: BrainDreamReviewRepository;
  notify?: BrainReviewNotifier;
  repository: BrainRepository;
  appId: string;
  runId: string;
  pageId: string | null;
  action: string;
  raw: unknown;
  decisionId: string;
}): Promise<{ outcome: 'proposed' | 'rejected'; reason: string }> {
  if (input.action === 'retire_page') {
    return {
      outcome: 'proposed',
      reason: 'retire_page is deferred in v1 (journaled without review)',
    };
  }
  return intakeDestructiveDreamOp(
    {
      repository: input.repository,
      reviews: input.reviews,
      notify: input.notify,
      appId: input.appId,
      runId: input.runId,
      pageId: input.pageId,
      nowIso: nowIso(),
    },
    input.raw,
    input.decisionId,
  );
}
