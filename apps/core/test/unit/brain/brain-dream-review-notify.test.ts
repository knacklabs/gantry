import { describe, expect, it, vi } from 'vitest';

import {
  brainReviewNotifyIdempotencyKey,
  buildBrainReviewNotification,
  createBrainReviewNotifier,
  type BrainReviewNotifyGateway,
} from '@core/brain/brain-dream-review-notify.js';

const REVIEW = {
  id: 'bdrv_1',
  action: 'delete_page',
  reviewSnapshot: {
    action: 'delete_page',
    before: { title: 'Q3 Plan' },
    dependents: { edges: [{ id: 'e1' }], embeddings: 2 },
  },
};

const OWNER = {
  recipient: 'owner-1',
  conversationJid: 'sl:D1',
  providerAccountId: 'slack_one',
};

describe('brain review notify', () => {
  it('idempotency key is stable and per-review', () => {
    expect(brainReviewNotifyIdempotencyKey('bdrv_1')).toBe(
      'brain-review:bdrv_1',
    );
    expect(brainReviewNotifyIdempotencyKey('bdrv_2')).not.toBe(
      brainReviewNotifyIdempotencyKey('bdrv_1'),
    );
  });

  it('builds a card view + fallback text carrying Approve/Reject buttons', () => {
    const { view, text } = buildBrainReviewNotification(REVIEW);
    expect(view.reviewId).toBe('bdrv_1');
    expect(view.buttons.map((b) => b.decision)).toEqual(['approve', 'reject']);
    expect(view.headline).toContain('Q3 Plan');
    expect(text).toContain(view.headline);
  });

  it('resolves the verified owner and enqueues idempotently', async () => {
    const enqueue = vi.fn(async () => ({ outboundDeliveryId: 'out-1' }));
    const gateway: BrainReviewNotifyGateway = { enqueue };
    const notify = createBrainReviewNotifier({
      gateway,
      appId: 'app',
      resolveOwner: async () => ({ owner: OWNER }),
    });

    await notify(REVIEW);
    await notify(REVIEW); // exactly-once at the caller relies on the key below

    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const call of enqueue.mock.calls) {
      expect(call[0]).toMatchObject({
        appId: 'app',
        conversationJid: 'sl:D1',
        providerAccountId: 'slack_one',
        idempotencyKey: 'brain-review:bdrv_1',
      });
      expect(call[0].brainReviewView.buttons).toHaveLength(2);
    }
  });

  it('catches a resolveOwner rejection: never throws, warns', async () => {
    const enqueue = vi.fn(async () => ({ outboundDeliveryId: 'out-1' }));
    const warn = vi.fn();
    const notify = createBrainReviewNotifier({
      gateway: { enqueue },
      appId: 'app',
      resolveOwner: async () => {
        throw new Error('owner lookup DB blip');
      },
      warn,
    });
    await expect(notify(REVIEW)).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatchObject({ reviewId: 'bdrv_1' });
  });

  it('catches a gateway.enqueue rejection: never throws, warns', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('enqueue DB blip');
    });
    const warn = vi.fn();
    const notify = createBrainReviewNotifier({
      gateway: { enqueue },
      appId: 'app',
      resolveOwner: async () => ({ owner: OWNER }),
      warn,
    });
    await expect(notify(REVIEW)).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatchObject({ reviewId: 'bdrv_1' });
  });

  it('skips delivery (never throws) when no verified owner is configured', async () => {
    const enqueue = vi.fn(async () => ({ outboundDeliveryId: 'out-1' }));
    const warn = vi.fn();
    const notify = createBrainReviewNotifier({
      gateway: { enqueue },
      appId: 'app',
      resolveOwner: async () => ({}),
      warn,
    });
    await expect(notify(REVIEW)).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
