import { describe, expect, it } from 'vitest';

import { renderBrainReviewCard } from '@core/domain/brain-review-card.js';
import { teamsBrainReviewCard } from '@core/channels/teams-cards.js';
import { readTeamsMessageAction } from '@core/channels/teams-message-actions.js';

const TARGET_JID = 'teams:19:abc@thread.v2';

function card(action: string, snapshot: Record<string, unknown>) {
  const view = renderBrainReviewCard({ reviewId: 'rev-1', action, snapshot });
  return teamsBrainReviewCard(view, { targetJid: TARGET_JID });
}

describe('teamsBrainReviewCard', () => {
  it('renders a delete_page headline + Approve/Reject Action.Execute buttons', () => {
    const c = card('delete_page', {
      before: { title: 'Launch Plan' },
      dependents: { edges: [{}, {}, {}], embeddings: 2 },
    });
    const headline = (c.body[0] as { text: string }).text;
    expect(headline).toContain('Delete page');
    expect(headline).toContain('3 evidence links');
    expect(headline).toContain('2 embeddings');

    expect(c.actions).toHaveLength(2);
    const [approve, reject] = c.actions;
    expect(approve.verb).toBe('gantry.brain.review');
    expect(approve.data).toMatchObject({
      action: 'message_action',
      kind: 'brain_dream_review_decision',
      reviewId: 'rev-1',
      decision: 'approve',
      targetJid: TARGET_JID,
    });
    expect(reject.data).toMatchObject({
      decision: 'reject',
      reviewId: 'rev-1',
    });
  });

  it('escapes card-injection syntax in snapshot-derived names', () => {
    const c = card('delete_edge', {
      before: { fromEntityId: '[x](y)`z`', type: 'mentions', toEntityId: 'B' },
    });
    const headline = (c.body[0] as { text: string }).text;
    // Link/backtick syntax is backslash-escaped, so no live link/code span.
    expect(headline).toContain('\\[x\\]\\(y\\)');
    expect(headline).not.toContain('[x](y)`z`');
  });

  it('renders merge headline and round-trips the callback via readTeamsMessageAction', () => {
    const c = card('merge_entities', {
      source: { name: 'Acme' },
      target: { name: 'Acme Corp' },
      mergeDelta: { edgesToRepoint: 4 },
    });
    expect((c.body[0] as { text: string }).text).toContain('Merge');

    const decoded = readTeamsMessageAction({ data: c.actions[0]!.data });
    expect(decoded).toEqual({
      kind: 'brain_dream_review_decision',
      reviewId: 'rev-1',
      decision: 'approve',
      targetJid: TARGET_JID,
    });
  });
});
