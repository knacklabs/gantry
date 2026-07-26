import { describe, expect, it, vi } from 'vitest';

import {
  buildObserverDigestMessageView,
  markObserverDigestInsight,
} from '@core/domain/observer-digest-view.js';
import type { ObserverDigestMessageView } from '@core/domain/observer-digest-view.js';
import {
  slackObserverDigestBlocks,
  slackObserverDigestFallbackText,
  parseSlackObserverFeedback,
} from '@core/channels/slack/observer-digest-affordances.js';
import { registerSlackMessageActionHandler } from '@core/channels/slack/channel-message-action-handler.js';
import { sendSlackMessage } from '@core/channels/slack/channel-delivery-helpers.js';
import {
  telegramObserverDigestMessage,
  TELEGRAM_OBSERVER_CALLBACK_PATTERN,
  OBSERVER_FEEDBACK_BY_CODE,
  truncateTelegramCallbackAnswer,
} from '@core/channels/telegram/observer-digest-message.js';
import { teamsObserverDigestCard } from '@core/channels/teams-cards.js';
import {
  readTeamsMessageAction,
  handleTeamsMessageAction,
} from '@core/channels/teams-message-actions.js';
import { sendTeamsTextOrActionMessage } from '@core/channels/teams-progress.js';
import type { MessageActionOutcome } from '@core/domain/types.js';

const ACTIONS = ['resolve', 'dismiss', 'snooze', 'less_like_this'] as const;

function makeView(overrides?: {
  count?: number;
  title?: (i: number) => string;
  summary?: (i: number) => string;
}): ObserverDigestMessageView {
  const count = overrides?.count ?? 3;
  const insights = Array.from({ length: count }, (_, i) => ({
    // `prin_` + 32 hex ≈ the real id length, to exercise Telegram's 64-byte cap.
    id: `prin_${'a'.repeat(32)}${i}`,
    title: overrides?.title?.(i) ?? `Insight ${i}`,
    summary: overrides?.summary?.(i) ?? `Summary ${i}`,
    insightType: 'commitment' as const,
  }));
  return buildObserverDigestMessageView({
    localDay: '2026-07-27',
    recipient: 'owner',
    insights,
  });
}

describe('observer digest — Slack render + codec', () => {
  it('renders 3 insight groups × 4 buttons carrying {insightId, action}', () => {
    const view = makeView();
    const blocks = slackObserverDigestBlocks(view);
    const actionBlocks = blocks.filter((b) => b.type === 'actions') as Array<{
      elements: Array<{ value: string }>;
    }>;
    expect(actionBlocks).toHaveLength(3);
    view.insights.forEach((insight, i) => {
      const elements = actionBlocks[i].elements;
      expect(elements).toHaveLength(4);
      const parsed = elements.map((e) =>
        parseSlackObserverFeedback(JSON.parse(e.value)),
      );
      expect(parsed.map((p) => p?.action)).toEqual([...ACTIONS]);
      for (const p of parsed) expect(p?.insightId).toBe(insight.insightId);
    });
  });

  it('escapes a malicious insight title/summary', () => {
    const view = makeView({
      count: 1,
      title: () => '<b>pwn</b>',
      summary: () => '<script>x</script> & <@U1>',
    });
    const json = JSON.stringify(slackObserverDigestBlocks(view));
    expect(json).not.toContain('<b>pwn</b>');
    expect(json).not.toContain('<script>');
    expect(json).toContain('&lt;b&gt;');
    expect(json).toContain('&amp;');
  });

  it('sendSlackMessage wires observerDigestView to native blocks', async () => {
    const postMessage = vi.fn(async () => ({ ok: true, ts: '1.2' }));
    const app = { client: { chat: { postMessage } } } as never;
    await sendSlackMessage({
      app,
      jid: 'sl:C1',
      channelId: 'C1',
      formattedText: 'fallback',
      options: { observerDigestView: makeView() },
      log: { warn: () => undefined },
      sendSnippetFallback: async () => null,
    });
    const payload = postMessage.mock.calls[0]?.[0] as {
      blocks?: Array<{ type: string }>;
    };
    expect(payload.blocks?.[0]).toMatchObject({ type: 'header' });
    expect(payload.blocks?.filter((b) => b.type === 'actions')).toHaveLength(3);
  });

  it('keeps every section text under Slack 3000 even with over-long title+summary', () => {
    const view = makeView({
      count: 3,
      title: () => 'T'.repeat(5000),
      summary: () => 'S'.repeat(5000),
    });
    const sections = slackObserverDigestBlocks(view).filter(
      (b) => (b as { type?: string }).type === 'section',
    ) as Array<{ text: { text: string } }>;
    for (const section of sections) {
      expect(section.text.text.length).toBeLessThanOrEqual(3000);
    }
  });

  it('bounds the section AFTER mrkdwn escaping (many & expand past raw caps)', () => {
    // 800 raw `&` (within SUMMARY_CAP) escape to 4000 `&amp;` > 3000; the escaped
    // payload must be truncated on whole entities (never a split &amp;).
    const view = makeView({ count: 1, summary: () => '&'.repeat(800) });
    const section = slackObserverDigestBlocks(view).find(
      (b) => (b as { type?: string }).type === 'section',
    ) as { text: { text: string } };
    expect(section.text.text.length).toBeLessThanOrEqual(3000);
    // No dangling half-entity at the cut (no `&` not part of a full entity).
    expect(section.text.text).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it('truncates the escaped section on whole code points (emoji straddling the cap is not split)', () => {
    // `&` escapes ×5, so the escaped payload crosses SLACK_SECTION_CAP with an
    // emoji sitting right at the boundary — the cut must not keep a lone surrogate.
    // 575 `&` escape to 2875 chars; the emoji run then straddles the ~2899 cut.
    const view = makeView({
      count: 1,
      summary: () => `${'&'.repeat(575)}${'😀'.repeat(60)}`,
    });
    const section = slackObserverDigestBlocks(view).find(
      (b) => (b as { type?: string }).type === 'section',
    ) as { text: { text: string } };
    const text = section.text.text;
    expect(text.length).toBeLessThanOrEqual(3000);
    // No lone high surrogate, no replacement char, lossless UTF-8 round-trip.
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text).not.toContain('�');
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
    expect(text.endsWith('…')).toBe(true);
  });

  it('escapes the fallback text so a captured mention/link cannot go live', () => {
    const view = makeView({
      count: 1,
      title: () => 'Ping <@U123> see <https://x|link>',
      summary: () => 'sum & more',
    });
    const text = slackObserverDigestFallbackText(view);
    expect(text).not.toContain('<@U123>');
    expect(text).toContain('&lt;@U123&gt;');
    expect(text).toContain('&amp;');
  });
});

describe('observer digest — Telegram render + codec', () => {
  it('renders one keyboard of 3 rows × 4 buttons; callback_data round-trips and stays < 64 bytes', () => {
    const view = makeView();
    const { reply_markup } = telegramObserverDigestMessage(view);
    const rows = reply_markup.inline_keyboard;
    expect(rows).toHaveLength(3);
    view.insights.forEach((insight, i) => {
      expect(rows[i]).toHaveLength(4);
      rows[i].forEach((button, ai) => {
        expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThan(
          64,
        );
        const m = TELEGRAM_OBSERVER_CALLBACK_PATTERN.exec(button.callback_data);
        expect(m).not.toBeNull();
        expect(OBSERVER_FEEDBACK_BY_CODE[m![1]]).toBe(ACTIONS[ai]);
        expect(m![2]).toBe(insight.insightId);
        expect(m![3]).toBe(view.localDay);
      });
    });
  });

  it('keeps the message under Telegram 4096 and drops trailing insights with "…and N more"', () => {
    // Many insights, each with capped-but-full fields: the aggregate would blow
    // past 4096, so the backstop must fire.
    const view = makeView({
      count: 12,
      title: () => 'T'.repeat(500),
      summary: () => 'S'.repeat(2000),
    });
    const { text, reply_markup } = telegramObserverDigestMessage(view);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/…and \d+ more/);
    // Dropped insights contribute no keyboard rows.
    expect(reply_markup.inline_keyboard.length).toBeLessThan(12);
  });

  it('does not add "…and N more" when the whole digest fits', () => {
    const { text } = telegramObserverDigestMessage(makeView({ count: 3 }));
    expect(text).not.toMatch(/…and \d+ more/);
  });

  it('does not false-drop insights whose ESCAPED HTML is large but RENDERED text fits', () => {
    // Each summary is 700 raw `<` (renders as 700 chars) but escapes to ~2800
    // chars of &lt;. Measuring the HTML source would blow the ceiling and drop
    // insights that render well under 4096; measuring rendered text keeps them.
    const view = makeView({ count: 3, summary: () => '<'.repeat(700) });
    const { text, reply_markup } = telegramObserverDigestMessage(view);
    expect(text).not.toMatch(/…and \d+ more/);
    expect(reply_markup.inline_keyboard).toHaveLength(3);
  });

  it('escapes a malicious title in the HTML text', () => {
    const { text } = telegramObserverDigestMessage(
      makeView({ count: 1, title: () => '<b>pwn</b> & co' }),
    );
    expect(text).not.toContain('<b>pwn</b>');
    expect(text).toContain('&lt;b&gt;pwn&lt;/b&gt;');
    expect(text).toContain('&amp;');
  });

  it('truncates a long callback answer to <= 200 chars (ellipsis) without throwing', () => {
    expect(truncateTelegramCallbackAnswer('short')).toBe('short');
    const long = 'x'.repeat(500);
    const capped = truncateTelegramCallbackAnswer(long);
    expect(Array.from(capped).length).toBeLessThanOrEqual(200);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('truncates by code points so an emoji straddling the UTF-16 boundary is not split into a lone surrogate', () => {
    // 💤 (U+1F4A4) is a surrogate pair. 198 'a' fill units 0–197, so the first
    // 💤 occupies units 198–199 — it STRADDLES the slice(0,199) cut.
    const input = 'a'.repeat(198) + '💤'.repeat(20);

    // Prove the guard bites: the naive slice cuts INSIDE the pair, leaving a
    // lone high surrogate at the end — exactly the bug we're guarding against.
    const naive = String.prototype.slice.call(input, 0, 199);
    const lastUnit = naive.charCodeAt(naive.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(true);

    const capped = truncateTelegramCallbackAnswer(input);
    const codePoints = Array.from(capped);
    expect(codePoints.length).toBeLessThanOrEqual(200);
    expect(capped).not.toContain('�'); // no replacement char
    // for...of iterates whole code points: a valid pair yields one char with a
    // codePointAt above the BMP, a lone surrogate yields a char IN the surrogate
    // range — so asserting none land in 0xD800–0xDFFF proves no split pair.
    for (const ch of capped) {
      const code = ch.codePointAt(0)!;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
    expect(codePoints[codePoints.length - 1]).toBe('…');
  });
});

type TeamsCard = ReturnType<typeof teamsObserverDigestCard>;

// Each insight's buttons live in an ActionSet INSIDE its Container (not the
// card-level actions footer), so pull them out per container.
function insightActionSets(card: TeamsCard): Array<Array<{ data: unknown }>> {
  return (card.body as Array<Record<string, unknown>>)
    .filter((block) => block.type === 'Container')
    .map((container) => {
      const items = (container.items ?? []) as Array<Record<string, unknown>>;
      const actionSet = items.find((item) => item.type === 'ActionSet');
      return (actionSet?.actions ?? []) as Array<{ data: unknown }>;
    });
}

describe('observer digest — Teams render + codec', () => {
  it('gives each insight Container its own 4-action ActionSet carrying that insight id (no flat footer)', () => {
    const view = makeView();
    const card = teamsObserverDigestCard(view, { targetJid: 'teams:c1' });
    // no card-level actions footer — buttons sit beside their insight
    expect(card.actions).toHaveLength(0);
    const sets = insightActionSets(card);
    expect(sets).toHaveLength(3);
    sets.forEach((actions, i) => {
      expect(actions).toHaveLength(4);
      const parsed = actions.map((a) => readTeamsMessageAction(a.data));
      expect(parsed.map((p) => (p as { feedback: string }).feedback)).toEqual([
        ...ACTIONS,
      ]);
      for (const p of parsed) {
        expect(p?.kind).toBe('observer_feedback');
        expect((p as { insightId: string }).insightId).toBe(
          view.insights[i].insightId,
        );
      }
    });
  });

  it('rejects a foreign-chat callback', async () => {
    const view = makeView({ count: 1 });
    const card = teamsObserverDigestCard(view, { targetJid: 'teams:owner' });
    const actionData = insightActionSets(card)[0][0].data;
    const sendDenied = vi.fn(async () => undefined);
    const onMessageAction = vi.fn(async () => undefined);
    const handled = await handleTeamsMessageAction({
      message: { id: 'm1', value: actionData } as never,
      jid: 'teams:intruder',
      userId: 'u1',
      onMessageAction,
      sendDenied,
    });
    expect(handled).toBe(true);
    expect(onMessageAction).not.toHaveBeenCalled();
    expect(sendDenied).toHaveBeenCalled();
  });

  it('sendTeamsTextOrActionMessage wires observerDigestView to a native card', async () => {
    const sendAdaptiveCard = vi.fn(async () => undefined);
    await sendTeamsTextOrActionMessage({
      sdkClient: { sendAdaptiveCard } as never,
      jid: 'teams:c1',
      text: 'fallback',
      options: { observerDigestView: makeView() },
    });
    const card = sendAdaptiveCard.mock.calls[0]?.[0]?.card as TeamsCard;
    const sets = insightActionSets(card);
    expect(sets).toHaveLength(3);
    expect(sets.every((actions) => actions.length === 4)).toBe(true);
  });
});

describe('observer digest — per-insight rebuild', () => {
  it('removes ONLY the acted insight controls + adds its marker; others intact', () => {
    const view = makeView();
    const acted = view.insights[1].insightId;
    const updated = markObserverDigestInsight(view, acted, 'resolve');

    expect(updated.insights[1].affordances).toHaveLength(0);
    expect(updated.insights[1].stateMarker).toBe('✓ resolved');
    expect(updated.insights[0].affordances).toHaveLength(4);
    expect(updated.insights[2].affordances).toHaveLength(4);

    const blocks = slackObserverDigestBlocks(updated);
    // only 2 insights keep an actions block; the acted one shows its marker
    expect(blocks.filter((b) => b.type === 'actions')).toHaveLength(2);
    expect(JSON.stringify(blocks)).toContain('✓ resolved');

    // Telegram: the acted insight has no keyboard row; the others keep theirs
    const rows =
      telegramObserverDigestMessage(updated).reply_markup.inline_keyboard;
    expect(rows).toHaveLength(2);
  });
});

describe('observer digest — Slack handler (rebuild vs private)', () => {
  function fakeApp() {
    let handler: (args: unknown) => Promise<void> = async () => {};
    const update = vi.fn(async () => undefined);
    const postEphemeral = vi.fn(async () => undefined);
    const app = {
      action: (_name: string, h: (args: unknown) => Promise<void>) => {
        handler = h;
      },
      client: { chat: { update, postEphemeral } },
    };
    return { app, update, postEphemeral, invoke: (a: unknown) => handler(a) };
  }

  const clickArgs = (insightId: string) => ({
    ack: vi.fn(async () => undefined),
    action: {
      value: JSON.stringify({
        kind: 'observer_feedback',
        insightId,
        action: 'resolve',
        localDay: '2026-07-27',
      }),
    },
    body: { channel: { id: 'C1' }, message: { ts: '9.9' }, user: { id: 'U1' } },
  });

  it('applied outcome rebuilds the digest (acted insight buttons dropped)', async () => {
    const view = makeView();
    const acted = view.insights[0].insightId;
    const outcome: MessageActionOutcome = {
      state: 'applied',
      receipt: 'done',
      observerDigestView: markObserverDigestInsight(view, acted, 'resolve'),
    };
    const { app, update, postEphemeral, invoke } = fakeApp();
    registerSlackMessageActionHandler(app as never, {
      onMessageAction: async () => outcome,
    });
    await invoke(clickArgs(acted));
    expect(postEphemeral).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0]?.[0] as {
      text: string;
      blocks: Array<{ type: string }>;
    };
    expect(call.blocks.filter((b) => b.type === 'actions')).toHaveLength(2);
    // a11y fallback: top-level text carries the OTHER insights, not just receipt.
    expect(call.text).toContain('done'); // receipt prefix
    expect(call.text).toContain('Insight 1');
    expect(call.text).toContain('Insight 2');
  });

  it('denied outcome replies privately and does NOT modify the digest', async () => {
    const outcome: MessageActionOutcome = {
      state: 'denied',
      receipt: 'not yours',
    };
    const { app, update, postEphemeral, invoke } = fakeApp();
    registerSlackMessageActionHandler(app as never, {
      onMessageAction: async () => outcome,
    });
    await invoke(clickArgs('prin_x'));
    expect(update).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });
});
