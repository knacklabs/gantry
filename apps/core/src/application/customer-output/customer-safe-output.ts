import type { AgentPersona } from '../../shared/agent-persona.js';
import { CUSTOMER_VISIBLE_DECLINE_MESSAGE } from '../../shared/user-visible-messages.js';

export interface CustomerOutputLogger {
  warn(meta: Record<string, unknown>, message: string): void;
}

// High-signal markers of internal implementation that must never reach an end
// customer. This is a deterministic backstop *behind* the agent's system prompt
// and the guardrail — not the primary control — so it is kept tight to avoid
// nuking innocent replies, and is fail-closed: on any match the whole reply is
// replaced rather than partially edited.
export const INTERNAL_LEAK_PATTERNS: readonly RegExp[] = [
  /\bmcp\b/i,
  /mcp__/,
  /\bx-caller-identity\b/i,
  /\bprivacy[ _-]?guard\b/i,
  /\bprivacy check\b/i,
  /\bsigned channel\b/i,
  /\bshopify (?:admin|api|integration)\b/i,
  /\badmin panel\b/i,
  /\badmin (?:tool|dashboard)\b/i,
  /\bknowledge base\b/i,
  /\bsecurity control\b/i,
  /\binternal lookup\b/i,
  /\berror code\b/i,
  /\bhttp\s+\d{3}\b/i,
  /\bstack\s?trace\b/i,
  /\b(?:PRIVACY_GUARD_FAILED|ACCESS_DENIED|SCOPE_MISSING|INVALID_CREDENTIALS|INTERNAL_ERROR|RATE_LIMITED|NOT_FOUND|INVALID_REQUEST)\b/,
];

export function findInternalLeak(text: string): string | undefined {
  return INTERNAL_LEAK_PATTERNS.find((pattern) => pattern.test(text))?.source;
}

// Guards a customer-facing outbound message. Developer-persona agents are
// allowed to surface implementation detail; every other persona — including an
// agent with no explicit persona — is treated as customer-facing and gets the
// fail-closed redaction. Replacing the whole message (rather than asking an LLM
// to rewrite it) keeps the backstop deterministic and incapable of re-leaking;
// a hit is logged so the underlying prompt can be fixed.
export function guardCustomerVisibleOutput(input: {
  text: string;
  persona: AgentPersona | undefined;
  conversationJid: string;
  logger?: CustomerOutputLogger;
}): string {
  if (input.persona === 'developer') return input.text;
  const matchedPattern = findInternalLeak(input.text);
  if (!matchedPattern) return input.text;
  input.logger?.warn(
    { conversationJid: input.conversationJid, matchedPattern },
    'Customer-visible output guard replaced a reply that leaked internal implementation detail',
  );
  return CUSTOMER_VISIBLE_DECLINE_MESSAGE;
}
