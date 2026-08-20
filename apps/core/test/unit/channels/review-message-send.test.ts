import { describe, expect, it, vi } from 'vitest';

import { sendSlackMessage } from '@core/channels/slack/channel-delivery-helpers.js';
import { sendTeamsTextOrActionMessage } from '@core/channels/teams-progress.js';
import type { ReviewMessageView } from '@core/memory/review-message-view.js';

function makeReviewView(
  overrides: Partial<ReviewMessageView> = {},
): ReviewMessageView {
  const reviewId = 'mrv_send1';
  return {
    reviewId,
    kind: 'contradiction',
    title: '🧠 Memory review · conflicting note',
    topic: 'user.location',
    sides: [
      { label: 'Now', value: 'Paris', source: 'chat' },
      { label: 'New', value: 'Berlin', source: 'chat' },
    ],
    change: '"Berlin"',
    why: 'a newer statement contradicts the note',
    evidence: [{ source: 'chat', snippet: 'moved to Berlin' }],
    affordances: [
      { label: 'Approve', decision: 'approve', reviewId },
      { label: 'Reject', decision: 'reject', reviewId },
      { label: 'Edit', decision: 'edit', reviewId },
    ],
    ...overrides,
  };
}

describe('memory-review native send', () => {
  it('Slack renders a job notification as Block Kit and otherwise sends plain text', async () => {
    const postMessage = vi.fn(async () => ({ ok: true, ts: '111.222' }));
    const app = { client: { chat: { postMessage } } } as never;

    await sendSlackMessage({
      app,
      jid: 'sl:C123',
      channelId: 'C123',
      formattedText: 'plain fallback text',
      options: {
        jobNotificationView: {
          status: 'completed',
          jobName: 'Lead enrichment',
          durationMs: 65_000,
          stats: {
            toolCount: 2,
            browserUsed: true,
            lastAction: 'browser_click',
          },
          result: {
            headline: "Enriched this morning's leads",
            items: [
              { outcome: 'done', label: 'Added Acme', detail: 'owner found' },
              { outcome: 'skipped', label: 'Skipped Globex' },
            ],
            nextAction: 'Review the new leads',
          },
          fallbackText: 'plain fallback text',
          nextRunAt: '2026-08-21T09:00:00.000Z',
        },
      },
      log: { warn: () => undefined },
      sendSnippetFallback: async () => null,
    });

    const nativePayload = postMessage.mock.calls[0]?.[0] as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(nativePayload.text).toBe('plain fallback text');
    expect(nativePayload.blocks[0]).toMatchObject({
      type: 'header',
      text: { text: '✅ Completed · Lead enrichment' },
    });
    const statsBlock = nativePayload.blocks.find(
      (block) =>
        block.type === 'context' && JSON.stringify(block).includes('2 tools'),
    );
    expect(statsBlock).toMatchObject({ type: 'context' });
    expect(JSON.stringify(statsBlock)).toContain(
      '1m 05s · 2 tools · browser used · last browser_click',
    );
    const bodyBlock = nativePayload.blocks.find(
      (block) =>
        block.type === 'section' &&
        JSON.stringify(block).includes('Added Acme'),
    );
    expect(bodyBlock).toMatchObject({ type: 'section' });
    expect(JSON.stringify(bodyBlock)).toContain('✅ Added Acme — owner found');
    expect(JSON.stringify(bodyBlock)).toContain('⏭️ Skipped Globex');
    expect(JSON.stringify(nativePayload.blocks)).toContain(
      'Next run: 2026-08-21T09:00:00.000Z',
    );

    await sendSlackMessage({
      app,
      jid: 'sl:C123',
      channelId: 'C123',
      formattedText: 'plain fallback text',
      options: {},
      log: { warn: () => undefined },
      sendSnippetFallback: async () => null,
    });

    expect(postMessage.mock.calls[1]?.[0]).toMatchObject({
      text: 'plain fallback text',
    });
    expect(postMessage.mock.calls[1]?.[0]).not.toHaveProperty('blocks');
  });

  it('Slack renders the review as Block Kit with three decision buttons', async () => {
    const postMessage = vi.fn(async () => ({ ok: true, ts: '111.222' }));
    const app = { client: { chat: { postMessage } } } as never;

    await sendSlackMessage({
      app,
      jid: 'sl:C123',
      channelId: 'C123',
      formattedText: 'fallback text',
      options: { reviewMessageView: makeReviewView() },
      log: { warn: () => undefined },
      sendSnippetFallback: async () => null,
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const payload = postMessage.mock.calls[0]?.[0] as {
      blocks?: Array<Record<string, unknown>>;
    };
    const blocks = payload.blocks ?? [];
    expect(blocks[0]).toMatchObject({ type: 'header' });
    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ text: { text: string }; value: string }>;
    };
    expect(actions.elements).toHaveLength(3);
    expect(actions.elements.map((e) => e.text.text)).toEqual([
      'Approve',
      'Reject',
      'Edit',
    ]);
    for (const element of actions.elements) {
      expect(JSON.parse(element.value)).toMatchObject({
        kind: 'memory_review_decision',
        reviewId: 'mrv_send1',
      });
    }
  });

  it('Teams renders the review as an Adaptive Card with three Action.Execute buttons', async () => {
    const sendAdaptiveCard = vi.fn(async () => undefined);
    const sdkClient = { sendAdaptiveCard } as never;

    await sendTeamsTextOrActionMessage({
      sdkClient,
      jid: 'teams:conversation-1',
      text: 'fallback text',
      options: { reviewMessageView: makeReviewView() },
    });

    expect(sendAdaptiveCard).toHaveBeenCalledTimes(1);
    const card = sendAdaptiveCard.mock.calls[0]?.[0]?.card as {
      actions: Array<{
        type: string;
        title: string;
        verb: string;
        data: unknown;
      }>;
    };
    expect(card.actions).toHaveLength(3);
    expect(card.actions.map((a) => a.title)).toEqual([
      'Approve',
      'Reject',
      'Edit',
    ]);
    for (const action of card.actions) {
      expect(action.type).toBe('Action.Execute');
      expect(action.data).toMatchObject({
        kind: 'memory_review_decision',
        reviewId: 'mrv_send1',
      });
    }
  });

  it('Slack shows a "＋N more pending" indicator on the native card', async () => {
    const postMessage = vi.fn(async () => ({ ok: true, ts: '1.2' }));
    const app = { client: { chat: { postMessage } } } as never;

    await sendSlackMessage({
      app,
      jid: 'sl:C123',
      channelId: 'C123',
      formattedText: 'fallback',
      options: { reviewMessageView: makeReviewView({ morePendingCount: 2 }) },
      log: { warn: () => undefined },
      sendSnippetFallback: async () => null,
    });

    const blocks = (postMessage.mock.calls[0]?.[0] as { blocks: unknown[] })
      .blocks;
    expect(JSON.stringify(blocks)).toContain('＋2 more pending reviews');
  });

  it('Slack omits the indicator when this is the only pending review', async () => {
    const postMessage = vi.fn(async () => ({ ok: true, ts: '1.2' }));
    const app = { client: { chat: { postMessage } } } as never;

    await sendSlackMessage({
      app,
      jid: 'sl:C123',
      channelId: 'C123',
      formattedText: 'fallback',
      options: { reviewMessageView: makeReviewView() },
      log: { warn: () => undefined },
      sendSnippetFallback: async () => null,
    });

    const blocks = (postMessage.mock.calls[0]?.[0] as { blocks: unknown[] })
      .blocks;
    expect(JSON.stringify(blocks)).not.toContain('more pending');
  });

  it('Teams shows a "＋N more pending" indicator on the card body', async () => {
    const sendAdaptiveCard = vi.fn(async () => undefined);
    const sdkClient = { sendAdaptiveCard } as never;

    await sendTeamsTextOrActionMessage({
      sdkClient,
      jid: 'teams:conversation-1',
      text: 'fallback',
      options: { reviewMessageView: makeReviewView({ morePendingCount: 1 }) },
    });

    const card = sendAdaptiveCard.mock.calls[0]?.[0]?.card;
    expect(JSON.stringify(card.body)).toContain('＋1 more pending review');
    expect(JSON.stringify(card.body)).not.toContain('reviews');
  });
});
