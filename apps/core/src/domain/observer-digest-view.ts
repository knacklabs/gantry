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
 * adapter (Task 4: Slack/Telegram/Teams) maps this to its own native
 * blocks/keyboard/card; nothing here is provider-specific. It lives in the
 * domain layer — beside review-message-view — so channel adapters can render it
 * without an adapters -> runtime import.
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
      title: insight.title,
      summary: insight.summary,
      type: insight.insightType,
      affordances: OBSERVER_FEEDBACK_AFFORDANCES.map((affordance) => ({
        kind: 'observer_feedback' as const,
        label: affordance.label,
        insightId: insight.id,
        action: affordance.action,
      })),
    })),
  };
}
