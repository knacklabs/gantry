import { describe, expect, it } from 'vitest';

import { renderBrainReviewCard } from '@core/domain/brain-review-card.js';
import {
  parseSlackBrainReview,
  slackBrainReviewBlocks,
} from '@core/channels/slack/brain-review-affordances.js';

const REVIEW_ID = 'rev-1';

function card(action: string, snapshot: Record<string, unknown>) {
  return renderBrainReviewCard({ reviewId: REVIEW_ID, action, snapshot });
}

describe('renderBrainReviewCard — compact "what changes" per op', () => {
  it('delete_page: title + evidence/embedding counts', () => {
    const view = card('delete_page', {
      before: { title: 'Launch Plan' },
      dependents: { edges: [{}, {}, {}], embeddings: 2 },
    });
    expect(view.headline).toBe(
      '🗑 Delete page «Launch Plan» — also removes 3 evidence links + 2 embeddings',
    );
    expect(view.buttons.map((b) => b.decision)).toEqual(['approve', 'reject']);
  });

  it('rewrite_page: headline + before→after detail', () => {
    const view = card('rewrite_page', {
      before: { title: 'Old', markdown: 'old first line\nmore' },
      after: { title: 'New', markdown: 'new first line\nmore' },
    });
    expect(view.headline).toBe('✏️ Rewrite page «Old»');
    expect(view.details).toContain('Title: «Old» → «New»');
    expect(view.details).toContain('Before: old first line');
    expect(view.details).toContain('After: new first line');
  });

  it('delete_entity: name + relationship count (singular)', () => {
    const view = card('delete_entity', {
      before: { name: 'Acme' },
      dependents: { edges: [{}] },
    });
    expect(view.headline).toBe(
      '🗑 Delete entity «Acme» — removes 1 relationship',
    );
  });

  it('delete_edge: A —type→ B from the edge snapshot', () => {
    const view = card('delete_edge', {
      before: { type: 'works_at', fromEntityId: 'E1', toEntityId: 'E2' },
    });
    expect(view.headline).toBe('🗑 Remove relationship: E1 —works_at→ E2');
  });

  it('merge_entities: source into target + repoint count', () => {
    const view = card('merge_entities', {
      source: { name: 'Bob' },
      target: { name: 'Robert' },
      mergeDelta: { edgesToRepoint: 4 },
    });
    expect(view.headline).toBe(
      '🔀 Merge «Bob» into «Robert» — repoints 4 relationships',
    );
  });

  it('degrades a malformed snapshot to a generic line, never throws', () => {
    const view = card('delete_page', {} as Record<string, unknown>);
    expect(view.headline).toContain('Delete page');
    expect(view.buttons).toHaveLength(2);
  });
});

describe('Slack brain-review render + codec', () => {
  it('escapes snapshot text and builds Approve/Reject buttons', () => {
    const view = card('delete_page', {
      before: { title: '<b>Plan & Co</b>' },
      dependents: { edges: [], embeddings: 0 },
    });
    const blocks = slackBrainReviewBlocks(view, {
      providerAccountId: 'slack_one',
    }) as Array<{
      type: string;
      text?: { text: string };
      elements?: unknown[];
    }>;
    const section = blocks[0]!;
    // mrkdwn-escaped: no live < > &.
    expect(section.text!.text).toContain('&lt;b&gt;Plan &amp; Co&lt;/b&gt;');
    const actions = blocks.find((b) => b.type === 'actions')!;
    const elements = actions.elements as Array<{
      value: string;
      style?: string;
    }>;
    expect(elements).toHaveLength(2);
    expect(elements[0]!.style).toBe('primary'); // approve
    expect(elements[1]!.style).toBe('danger'); // reject
  });

  it('round-trips a button value back to {reviewId, decision}', () => {
    const view = card('delete_edge', {
      before: { type: 'mentions', fromEntityId: 'A', toEntityId: 'B' },
    });
    const blocks = slackBrainReviewBlocks(view) as Array<{
      type: string;
      elements?: Array<{ value: string }>;
    }>;
    const value = blocks.find((b) => b.type === 'actions')!.elements![0]!.value;
    expect(parseSlackBrainReview(JSON.parse(value))).toEqual({
      reviewId: REVIEW_ID,
      decision: 'approve',
    });
  });

  it('rejects a foreign / malformed callback value', () => {
    expect(parseSlackBrainReview({ kind: 'observer_feedback' })).toBeNull();
    expect(
      parseSlackBrainReview({
        kind: 'brain_dream_review_decision',
        reviewId: '',
        decision: 'approve',
      }),
    ).toBeNull();
    expect(
      parseSlackBrainReview({
        kind: 'brain_dream_review_decision',
        reviewId: 'r',
        decision: 'edit',
      }),
    ).toBeNull();
  });
});
