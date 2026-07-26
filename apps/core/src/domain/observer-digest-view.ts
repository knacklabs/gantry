import type {
  MessageActionAffordance,
  ObserverFeedbackAction,
} from './message-actions.js';
import type {
  ObserverInsightType,
  ProactiveInsight,
} from './ports/observer-insights.js';

/**
 * Provider-neutral view model for an observer digest message. Each channel
 * adapter maps this to its own native representation (blocks/keyboard/card);
 * nothing here is provider-specific. It lives in the domain layer — beside
 * review-message-view — so channel adapters can render it without an
 * adapters -> runtime import.
 *
 * It is an IMMUTABLE snapshot built at reserve time and persisted on the digest
 * reservation, so the affordances survive a recovery/resend (today the gateway
 * carries only rendered TEXT, so buttons would be lost on recovery).
 */
export interface ObserverDigestMessageView {
  localDay: string;
  recipient: string;
  insights: ObserverDigestInsightView[];
}

export interface ObserverDigestInsightView {
  insightId: string;
  title: string;
  summary: string;
  type: ObserverInsightType;
  affordances: ObserverFeedbackAffordance[];
  /**
   * Set once an owner action settles this insight (buttons dropped). Rendered in
   * place of the button group so the other insights stay actionable in the same
   * message. Absent while the insight is still open.
   */
  stateMarker?: string;
}

/** The in-message state marker each terminal action leaves on its insight. */
export const OBSERVER_FEEDBACK_MARKERS: Record<ObserverFeedbackAction, string> =
  {
    resolve: '✓ resolved',
    dismiss: '✕ dismissed',
    snooze: '💤 snoozed',
    less_like_this: '👎 fewer like this',
  };

/**
 * Rebuild the digest view after ONE insight is acted on: the acted insight loses
 * its affordances and gains its state marker; every other insight is untouched
 * and still actionable. Pure — the host (Task 5) calls it with the reservation's
 * durable view; channel adapters then re-render the returned view natively.
 */
export function markObserverDigestInsight(
  view: ObserverDigestMessageView,
  insightId: string,
  action: ObserverFeedbackAction,
): ObserverDigestMessageView {
  return {
    ...view,
    insights: view.insights.map((insight) =>
      insight.insightId === insightId
        ? {
            ...insight,
            affordances: [],
            stateMarker: OBSERVER_FEEDBACK_MARKERS[action],
          }
        : insight,
    ),
  };
}

/** The `observer_feedback` variant of the shared message-action affordance. */
export type ObserverFeedbackAffordance = Extract<
  MessageActionAffordance,
  { kind: 'observer_feedback' }
>;

/**
 * The four feedback affordances every surfaced insight carries, in render
 * order. ponytail: fixed set + labels; there is no per-insight variation.
 */
const OBSERVER_FEEDBACK_AFFORDANCES: ReadonlyArray<{
  action: ObserverFeedbackAction;
  label: string;
}> = [
  { action: 'resolve', label: 'Resolve' },
  { action: 'dismiss', label: 'Dismiss' },
  { action: 'snooze', label: 'Snooze' },
  { action: 'less_like_this', label: 'Less like this' },
];

/**
 * Build the provider-neutral digest view from the ordered, reserved insights
 * (the SAME insights the text render uses). Pure over its inputs so unit tests
 * and channel adapters can consume it without the runtime.
 */
// Per-field caps so a single-message native render can't blow past a channel's
// per-section (~3000-char) or per-message (~4096-char) limit. Applied here so
// every channel adapter inherits the same bound. The digest is a small top-N
// (schedule.maxInsights), so these per-field caps bound the aggregate too; a
// channel with a per-message limit additionally backstops the assembled total.
const TITLE_CAP = 160;
const SUMMARY_CAP = 800;

// Cut on whole code points (Array.from splits on code points, not UTF-16 units)
// so a supplementary char / emoji straddling the cap can't become a lone
// surrogate → replacement-char corruption.
function truncateField(value: string, max: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= max
    ? value
    : `${codePoints.slice(0, max - 1).join('')}…`;
}

export function buildObserverDigestMessageView(input: {
  localDay: string;
  recipient: string;
  insights: ReadonlyArray<
    Pick<ProactiveInsight, 'id' | 'title' | 'summary' | 'insightType'>
  >;
}): ObserverDigestMessageView {
  return {
    localDay: input.localDay,
    recipient: input.recipient,
    insights: input.insights.map((insight) => ({
      insightId: insight.id,
      title: truncateField(insight.title, TITLE_CAP),
      summary: truncateField(insight.summary, SUMMARY_CAP),
      type: insight.insightType,
      affordances: OBSERVER_FEEDBACK_AFFORDANCES.map((affordance) => ({
        kind: 'observer_feedback' as const,
        label: affordance.label,
        insightId: insight.id,
        action: affordance.action,
        localDay: input.localDay,
      })),
    })),
  };
}
