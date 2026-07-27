import { describe, expect, it, vi } from 'vitest';

import { createChannelMessageActionRouter } from '@core/app/bootstrap/channel-message-action-router.js';
import {
  handleBrainDreamReviewAction,
  type BrainReviewMessageActionDeps,
} from '@core/app/bootstrap/runtime-brain-review-message-action.js';
import type { BrainDreamReviewMessageActionInput } from '@core/domain/types.js';

const OWNER = {
  recipient: 'U-owner',
  conversationJid: 'sl:D1',
  providerAccountId: 'slack_one',
};

function input(
  overrides: Partial<BrainDreamReviewMessageActionInput> = {},
): BrainDreamReviewMessageActionInput {
  return {
    kind: 'brain_dream_review_decision',
    conversationJid: OWNER.conversationJid,
    providerAccountId: OWNER.providerAccountId,
    userId: OWNER.recipient,
    reviewId: 'rev-1',
    decision: 'approve',
    ...overrides,
  };
}

describe('channel-message-action router — brain_dream_review_decision', () => {
  it('routes a valid callback to the brain review handler', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn(async () => ({
      state: 'applied' as const,
      receipt: 'ok',
    }));
    router.setBrainDreamReviewHandler(handler);
    await router.handle(input());
    expect(handler).toHaveBeenCalledOnce();
  });

  it('drops an invalid callback (blank reviewId / bad decision) before the handler', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn(async () => ({
      state: 'applied' as const,
      receipt: 'ok',
    }));
    router.setBrainDreamReviewHandler(handler);
    await router.handle(input({ reviewId: '  ' }));
    await router.handle(input({ decision: 'edit' as unknown as 'approve' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not disturb observer / memory-review routing (regression)', async () => {
    const router = createChannelMessageActionRouter();
    const observer = vi.fn(async () => undefined);
    const memory = vi.fn(async () => ({
      state: 'applied' as const,
      receipt: 'ok',
    }));
    router.setObserverFeedbackHandler(observer);
    router.setMemoryReviewHandler(memory);
    await router.handle({
      kind: 'observer_feedback',
      conversationJid: 'sl:D1',
      userId: 'U1',
      insightId: 'i1',
      action: 'resolve',
      localDay: '2026-07-27',
    });
    await router.handle({
      kind: 'memory_review_decision',
      conversationJid: 'sl:D1',
      userId: 'U1',
      reviewId: 'mrv-1',
      decision: 'approve',
      label: '',
    });
    expect(observer).toHaveBeenCalledOnce();
    expect(memory).toHaveBeenCalledOnce();
  });
});

describe('owner-only brain review executor handler', () => {
  function deps(overrides: Partial<BrainReviewMessageActionDeps> = {}): {
    deps: BrainReviewMessageActionDeps;
    execute: ReturnType<typeof vi.fn>;
  } {
    const execute = vi.fn(async () => ({
      outcome: 'applied' as const,
      mutated: true,
    }));
    return {
      execute,
      deps: {
        appId: 'app-1',
        resolveVerifiedOwner: async () => ({ owner: OWNER }),
        executeDecision: execute,
        warn: () => {},
        ...overrides,
      },
    };
  }

  it('owner approve → executor called → applied, buttons cleared', async () => {
    const { deps: d, execute } = deps();
    const out = await handleBrainDreamReviewAction(d, input());
    expect(execute).toHaveBeenCalledOnce();
    expect(out.state).toBe('applied');
    expect(out.clearActions).toBe(true);
  });

  it('non-owner user → denied, executor NEVER called', async () => {
    const { deps: d, execute } = deps();
    const out = await handleBrainDreamReviewAction(
      d,
      input({ userId: 'U-intruder' }),
    );
    expect(out.state).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('foreign conversation/account → denied, executor NEVER called', async () => {
    const { deps: d, execute } = deps();
    expect(
      (
        await handleBrainDreamReviewAction(
          d,
          input({ conversationJid: 'sl:D9' }),
        )
      ).state,
    ).toBe('denied');
    expect(
      (
        await handleBrainDreamReviewAction(
          d,
          input({ providerAccountId: 'slack_two' }),
        )
      ).state,
    ).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('unconfigured owner → denied', async () => {
    const { deps: d, execute } = deps({
      resolveVerifiedOwner: async () => ({}),
    });
    const out = await handleBrainDreamReviewAction(d, input());
    expect(out.state).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps a lost at-most-once race (applying) to a private denied note', async () => {
    const { deps: d } = deps({
      executeDecision: async () => ({ outcome: 'applying', mutated: false }),
    });
    const out = await handleBrainDreamReviewAction(d, input());
    expect(out.state).toBe('denied'); // non-terminal: shared card untouched
  });

  it('maps drift (stale) to a terminal stale outcome', async () => {
    const { deps: d } = deps({
      executeDecision: async () => ({ outcome: 'stale', mutated: false }),
    });
    const out = await handleBrainDreamReviewAction(d, input());
    expect(out.state).toBe('stale');
    expect(out.clearActions).toBe(true);
  });
});
