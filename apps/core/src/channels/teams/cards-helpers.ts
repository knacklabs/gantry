import type { ReviewMessageSide } from '../../domain/review-message-view.js';

/**
 * Neutralize dynamic snapshot text before embedding it in an Adaptive Card
 * TextBlock (Teams renders a markdown subset). Backslash-escaping the link
 * syntax `[ ] ( )`, the code backtick, and the angle brackets means captured
 * memory can't inject a live link, code span, or a `<at>` mention. Mirrors the
 * intent of the Slack mrkdwn / Telegram HTML escaping in T5. Emphasis chars
 * (`_`/`*`) are intentionally left alone so common keys like `coffee_order`
 * render cleanly — they carry no injection risk.
 */
export function escapeTeamsCardText(value: string): string {
  return value.replace(/[\\<>[\]()`]/g, '\\$&');
}

export function teamsSideFact(side: ReviewMessageSide): {
  title: string;
  value: string;
} {
  const meta = [side.source, side.date]
    .filter(Boolean)
    .map((part) => escapeTeamsCardText(part as string))
    .join(' · ');
  const value = `"${escapeTeamsCardText(side.value)}"`;
  return {
    title: escapeTeamsCardText(side.label),
    value: meta ? `${value} — ${meta}` : value,
  };
}
