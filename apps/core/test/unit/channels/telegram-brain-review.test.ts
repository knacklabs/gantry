import { describe, expect, it } from 'vitest';

import { renderBrainReviewCard } from '@core/domain/brain-review-card.js';
import {
  TELEGRAM_BRAIN_REVIEW_CALLBACK_PATTERN,
  TELEGRAM_BRAIN_REVIEW_DECISION_BY_CODE,
  telegramBrainReviewMessage,
} from '@core/channels/telegram/message-action-affordances.js';

function render(
  reviewId: string,
  action: string,
  snapshot: Record<string, unknown>,
) {
  return telegramBrainReviewMessage(
    renderBrainReviewCard({ reviewId, action, snapshot }),
  );
}

describe('telegramBrainReviewMessage', () => {
  it('renders delete_page headline + Approve/Reject callbacks', () => {
    const msg = render('rev1', 'delete_page', {
      before: { title: 'Launch Plan' },
      dependents: { edges: [{}, {}, {}], embeddings: 2 },
    });
    expect(msg.text).toContain('Delete page «Launch Plan»');
    expect(msg.text).toContain('3 evidence links');
    expect(msg.text).toContain('2 embeddings');
    const buttons = msg.reply_markup.inline_keyboard[0]!;
    expect(buttons.map((b) => b.callback_data)).toEqual([
      'bd:a:rev1',
      'bd:r:rev1',
    ]);
    expect(buttons.map((b) => b.text)).toEqual(['Approve', 'Reject']);
  });

  it('HTML-escapes snapshot-derived text (no injection)', () => {
    const msg = render('rev2', 'delete_page', {
      before: { title: '<b>&pwn' },
      dependents: { edges: [], embeddings: 0 },
    });
    expect(msg.text).toContain('&lt;b&gt;&amp;pwn');
    expect(msg.text).not.toContain('<b>&pwn');
  });

  it('renders rewrite_page before→after detail lines', () => {
    const msg = render('rev3', 'rewrite_page', {
      before: { title: 'Old', markdown: 'old first line' },
      after: { title: 'New', markdown: 'new first line' },
    });
    expect(msg.text).toContain('Rewrite page «Old»');
    expect(msg.text).toContain('Title: «Old» → «New»');
    expect(msg.text).toContain('new first line');
  });

  it('renders merge_entities repoint count', () => {
    const msg = render('rev4', 'merge_entities', {
      source: { name: 'Alice' },
      target: { name: 'Alicia' },
      mergeDelta: { edgesToRepoint: 5 },
    });
    expect(msg.text).toContain('Merge «Alice» into «Alicia»');
    expect(msg.text).toContain('repoints 5 relationships');
  });

  it('bounds an over-long card to Telegram 4096 with valid HTML + buttons', () => {
    const msg = render('revL', 'delete_page', {
      before: { title: 'X'.repeat(10_000) },
      dependents: { edges: [], embeddings: 0 },
    });
    // Telegram counts UTF-16 units (JS .length); over the hard limit = rejected.
    expect(msg.text.length).toBeLessThanOrEqual(4096);
    // Valid HTML: exactly one balanced <b></b>, no dangling entity anywhere.
    expect(msg.text.match(/<b>/g)!.length).toBe(1);
    expect(msg.text.match(/<\/b>/g)!.length).toBe(1);
    expect(msg.text.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
    // Buttons still attach.
    const buttons = msg.reply_markup.inline_keyboard[0]!;
    expect(buttons.map((b) => b.callback_data)).toEqual([
      'bd:a:revL',
      'bd:r:revL',
    ]);
  });

  it('entity-safe truncation: a title of all-escaping chars never splits &amp;', () => {
    // '&' → '&amp;' (5 units); a 2000-char title escapes to 10000 units, so the
    // headline must be truncated — mid-entity cuts must be repaired.
    const msg = render('revE', 'delete_page', {
      before: { title: '&'.repeat(2000) },
      dependents: { edges: [], embeddings: 0 },
    });
    expect(msg.text.length).toBeLessThanOrEqual(4096);
    expect(msg.text.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
  });

  it('callback_data round-trips back to {decision, reviewId}', () => {
    const match = TELEGRAM_BRAIN_REVIEW_CALLBACK_PATTERN.exec('bd:r:rev-xyz');
    expect(match).not.toBeNull();
    expect(TELEGRAM_BRAIN_REVIEW_DECISION_BY_CODE[match![1]!]).toBe('reject');
    expect(match![2]).toBe('rev-xyz');
  });
});
