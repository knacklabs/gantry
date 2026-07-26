import { describe, expect, it } from 'vitest';

import { buildReviewMessageView } from '@core/memory/review-message-view.js';
import { slackReviewMessageBlocks } from '@core/channels/slack/message-action-affordances.js';
import { telegramReviewMessage } from '@core/channels/telegram/message-action-affordances.js';
import type {
  MemoryLifecycleProposal,
  MemoryReviewRecord,
  MemoryReviewSnapshot,
} from '@core/memory/memory-types.js';

function record(
  proposal: Partial<MemoryLifecycleProposal>,
  snapshot: MemoryReviewSnapshot,
  id = 'mrv_0123456789abcdef0123456789abcdef',
): MemoryReviewRecord {
  return {
    appId: 'default',
    agentId: 'main_agent',
    subjectType: 'user',
    subjectId: 'u-1',
    id,
    runId: 'run-1',
    phase: 'deep',
    proposal: {
      action: 'needs_review',
      reason: 'default reason',
      confidence: 0.9,
      evidenceIds: [],
      ...proposal,
    },
    status: 'pending_review',
    itemVersions: {},
    candidateVersions: {},
    validationSummary: '',
    reviewSnapshot: snapshot,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

const contradictionSnapshot: MemoryReviewSnapshot = {
  schemaVersion: 1,
  subject: {
    appId: 'default',
    agentId: 'main_agent',
    subjectType: 'user',
    subjectId: 'u-1',
  },
  conflict: {
    active: {
      itemId: 'i-1',
      kind: 'preference',
      key: 'coffee_order',
      value: 'oat flat white',
      evidenceIds: ['e-active'],
    },
    incoming: {
      candidateId: 'c-1',
      kind: 'preference',
      key: 'coffee_order',
      value: 'almond cappuccino',
      evidenceIds: ['e-incoming'],
    },
  },
  proposedCanonical: {
    kind: 'preference',
    key: 'coffee_order',
    value: 'almond cappuccino',
    reason: 'Most recent explicit statement wins',
    evidenceIds: ['e-incoming'],
  },
  evidence: [
    {
      id: 'e-active',
      role: 'active',
      sourceType: 'message',
      text: 'I always get an oat flat white',
      capturedAt: '2026-06-01T10:00:00.000Z',
    },
    {
      id: 'e-incoming',
      role: 'incoming',
      sourceType: 'session',
      text: 'Switched to almond cappuccino this month',
      capturedAt: '2026-07-20T10:00:00.000Z',
    },
  ],
};

describe('buildReviewMessageView', () => {
  it('renders a contradiction with Now/New/Change/Why, both sources+dates, bounded evidence', () => {
    const view = buildReviewMessageView(
      record({ action: 'needs_review' }, contradictionSnapshot),
    );
    expect(view.kind).toBe('contradiction');
    expect(view.title).toContain('conflicting note');
    expect(view.topic).toBe('coffee_order');
    expect(view.sides).toEqual([
      {
        label: 'Now',
        value: 'oat flat white',
        source: 'message',
        date: 'Jun 1, 2026',
      },
      {
        label: 'New',
        value: 'almond cappuccino',
        source: 'session',
        date: 'Jul 20, 2026',
      },
    ]);
    expect(view.change).toBe('"almond cappuccino"');
    expect(view.why).toBe('Most recent explicit statement wins');
    expect(view.evidence).toHaveLength(2);
    expect(view.affordances.map((a) => a.decision)).toEqual([
      'approve',
      'reject',
      'edit',
    ]);
    expect(view.affordances.every((a) => a.reviewId === view.reviewId)).toBe(
      true,
    );
  });

  it('renders retire as remove with a single Now side', () => {
    const snapshot: MemoryReviewSnapshot = {
      ...contradictionSnapshot,
      conflict: { active: contradictionSnapshot.conflict!.active },
      proposedCanonical: undefined,
      evidence: [contradictionSnapshot.evidence[0]],
    };
    const view = buildReviewMessageView(
      record({ action: 'retire', reason: 'No longer true' }, snapshot),
    );
    expect(view.kind).toBe('retire');
    expect(view.sides).toHaveLength(1);
    expect(view.sides[0].label).toBe('Now');
    expect(view.change).toBe('remove this note');
    expect(view.why).toBe('No longer true');
  });

  it('renders rewrite as Now → new value', () => {
    const snapshot: MemoryReviewSnapshot = {
      ...contradictionSnapshot,
      conflict: { active: contradictionSnapshot.conflict!.active },
      proposedCanonical: {
        kind: 'preference',
        key: 'coffee_order',
        value: 'oat cortado',
        reason: 'Corrected wording',
        evidenceIds: ['e-active'],
      },
      evidence: [contradictionSnapshot.evidence[0]],
    };
    const view = buildReviewMessageView(
      record({ action: 'rewrite' }, snapshot),
    );
    expect(view.kind).toBe('rewrite');
    expect(view.sides).toHaveLength(1);
    expect(view.change).toBe('"oat cortado"');
    expect(view.why).toBe('Corrected wording');
  });

  it('renders merge listing participants into the target', () => {
    const snapshot: MemoryReviewSnapshot = {
      schemaVersion: 1,
      subject: contradictionSnapshot.subject,
      conflict: {
        active: {
          itemId: 'i-target',
          kind: 'fact',
          key: 'home_city',
          value: 'Berlin',
          evidenceIds: ['e-t'],
        },
      },
      retiring: [
        {
          itemId: 'i-2',
          kind: 'fact',
          key: 'home_city',
          value: 'Berlin, DE',
          evidenceIds: ['e-2'],
        },
      ],
      evidence: [
        {
          id: 'e-t',
          role: 'active',
          sourceType: 'message',
          text: 'I live in Berlin',
          capturedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    };
    const view = buildReviewMessageView(
      record({ action: 'merge', reason: 'Same place' }, snapshot),
    );
    expect(view.kind).toBe('merge');
    expect(view.sides.map((s) => s.label)).toEqual(['Keep', 'Merge']);
    expect(view.change).toBe('merge 2 notes into "home_city"');
  });

  it('truncates long values in the message', () => {
    const long = 'x'.repeat(400);
    const snapshot: MemoryReviewSnapshot = {
      ...contradictionSnapshot,
      conflict: {
        active: { ...contradictionSnapshot.conflict!.active, value: long },
        incoming: contradictionSnapshot.conflict!.incoming,
      },
    };
    const view = buildReviewMessageView(
      record({ action: 'needs_review' }, snapshot),
    );
    expect(view.sides[0].value.length).toBeLessThanOrEqual(140);
    expect(view.sides[0].value.endsWith('…')).toBe(true);
  });
});

describe('slackReviewMessageBlocks', () => {
  it('renders header + topic/side fields + change + evidence context + 3 buttons', () => {
    const view = buildReviewMessageView(
      record({ action: 'needs_review' }, contradictionSnapshot),
    );
    const blocks = slackReviewMessageBlocks(view, {
      providerAccountId: 'slack_default',
    });
    expect(blocks[0]).toMatchObject({ type: 'header' });
    expect(JSON.stringify(blocks[1])).toContain('Topic:');
    expect(JSON.stringify(blocks[1])).toContain('Now:');
    expect(JSON.stringify(blocks[1])).toContain('New:');
    const changeBlock = JSON.stringify(blocks[2]);
    expect(changeBlock).toContain('Change');
    expect(changeBlock).toContain('Why:');
    const context = blocks.find((b) => b.type === 'context');
    expect(context).toBeDefined();
    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions.elements).toHaveLength(3);
    expect(actions.elements[0].action_id).toBe('gantry_message_action');
    const payload = JSON.parse(actions.elements[0].value);
    expect(payload).toMatchObject({
      kind: 'memory_review_decision',
      reviewId: view.reviewId,
      decision: 'approve',
      providerAccountId: 'slack_default',
    });
  });

  it('escapes malicious snapshot content so it cannot become a live mention/link', () => {
    const snapshot: MemoryReviewSnapshot = {
      ...contradictionSnapshot,
      conflict: {
        active: {
          ...contradictionSnapshot.conflict!.active,
          value: 'ping <@U123> see <https://evil.example|click>',
        },
        incoming: contradictionSnapshot.conflict!.incoming,
      },
    };
    const view = buildReviewMessageView(
      record({ action: 'needs_review' }, snapshot),
    );
    const rendered = JSON.stringify(slackReviewMessageBlocks(view));
    expect(rendered).not.toContain('<@U123>');
    expect(rendered).not.toContain('<https://evil.example|click>');
    expect(rendered).toContain('&lt;@U123&gt;');
    expect(rendered).toContain('&lt;https://evil.example|click&gt;');
  });
});

describe('telegramReviewMessage', () => {
  it('renders HTML with an expandable blockquote and mr: keyboard under 64 bytes', () => {
    const view = buildReviewMessageView(
      record({ action: 'needs_review' }, contradictionSnapshot),
    );
    const { text, reply_markup } = telegramReviewMessage(view);
    expect(text).toContain('<b>');
    expect(text).toContain('Topic:');
    expect(text).toContain('<blockquote expandable>');
    const buttons = reply_markup.inline_keyboard[0];
    expect(buttons.map((b) => b.callback_data)).toEqual([
      `mr:a:${view.reviewId}`,
      `mr:r:${view.reviewId}`,
      `mr:e:${view.reviewId}`,
    ]);
    for (const button of buttons) {
      expect(
        Buffer.byteLength(button.callback_data, 'utf8'),
      ).toBeLessThanOrEqual(64);
    }
  });
});
