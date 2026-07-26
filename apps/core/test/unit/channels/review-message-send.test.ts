import { describe, expect, it, vi } from 'vitest';

import { sendSlackMessage } from '@core/channels/slack/channel-delivery-helpers.js';
import { sendTeamsTextOrActionMessage } from '@core/channels/teams-progress.js';
import type { ReviewMessageView } from '@core/memory/review-message-view.js';

function makeReviewView(): ReviewMessageView {
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
  };
}

describe('memory-review native send', () => {
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
});
