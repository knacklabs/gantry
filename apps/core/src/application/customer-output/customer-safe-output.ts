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
  /\bKB\b/,
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

// A leading "I'll look up… / let me check… / looking that up…" sentence is
// lookup preamble the customer should never see — a customer reply must lead
// with the answer, not narrate the fetch. Generic English narration only (no
// agent-specific phrasing); models tend to emit this before a tool call and it
// gets glued to the answer ("…now.Your order is…").
const LEADING_NARRATION_RE =
  /\b(?:i['’]?ll\s+(?:just\s+|quickly\s+)?(?:look(?:\s+(?:that|it|this))?\s*up|pull(?:\s+(?:that|it|this))?\s*up|check|fetch|grab|pull|search)|i['’]?ll\s+answer\s+honestly\b|i['’]?ll\s+be\s+honest\b|i['’]?ll\s+ask\b|i['’]?ll\s+acknowledge\b|i['’]?ll\s+let\s+the\s+customer\s+know\b|i\s+should\s+ask\b|i\s+need\s+to\s+(?:look\s+up|check|pull|search)\b|let me\s+(?:just\s+|quickly\s+)?(?:look(?:\s+(?:that|it|this))?\s*up|pull(?:\s+(?:that|it|this))?\s*up|check|fetch|grab|pull|search)|let me\s+do\s+that\s+now\b|let me\s+try[^.!?\n]*\bsearch\b|let me\s+search\s+specifically\b|let me\s+ask[^.!?\n]*\b(?:clarifying\s+question|missing\s+detail)\b|let me\s+capture\b|looking\s+(?:that\s+up|it\s+up|up\b)|searching\b|pulling\s+(?:that|this|it|your)[^.!?\n]*\bup\b|fetching\b|one moment\b|on it\b|the\s+tools\s+are\s+now\s+available\b|that\s+search\s+only\s+returned\b|the\s+search\s+didn['’]?t\s+(?:return|surface|find)\b|the\s+source\s+(?:didn['’]?t\s+(?:return|surface|find)|has)\b|usecustomerreplydraft\b|contract\s+constraints\b|live\s+stock\s+guarantee\b|products\s+returned\b|i\s+won['’]?t\s+invent\s+stock\b|these\s+results\s+are\b|the\s+results\s+here\b|the\s+customer\s+is\s+asking\b|clear\s+(?:corporate(?:\/bulk)?|bulk(?:\/corporate)?)\s+(?:gifting\s+lead|gifting\s+signal|signal|brief)\b|capturing\s+the\s+brief\b|strong\s+b2b\s+signals\b|route\s+warmly\b|routing\s+to\b|brief\s+intake\b|this\s+message\s+seems\s+to\s+be\s+a\s+continuation\b|this\s+is\s+(?:an?\s+)?[^.!?\n]{0,80}\b(?:request|brief)\b[^.!?\n]*\b(?:i['’]?ll|bulk|corporate|gifting|GST|logo)\b|prior\s+conversation\s+context\b|without\s+knowing\s+what\s+product\b|message\s+says\b|implying\s+a\s+prior\s+product\b|respond\s+naturally\b|warm,\s+honest\s+reply\b|moves\s+things\s+forward\b|since\s+i\s+(?:don['’]?t|have\s+no)\s+(?:have\s+)?(?:prior\s+)?context\b|since\s+i\s+don['’]?t\s+have\s+(?:a\s+)?confirmed\b|since\s+there['’]?s\s+no\s+prior\s+context\b|some\s+codes\s+apply\s+on\s+order\s+date\b|others\s+on\s+delivery\s+date\b|no\s+confirmed\s+source\s+tool\b|in\s+this\s+session\b|no\s+specific\s+product\s+was\s+mentioned\b|without\s+making\s+any\s+stock\b|here['’]?s\s+a\s+reply\b|route\s+this\s+correctly\b|confirmed\s+source\s+data\b|honou?r(?:ing)?\s+the\s+reply\s+contract\b|reply\s+contract\b|(?:the|our)\s+kb\b|the\s+context\s+here\b)/i;

// A lookup-narration sentence is not always the FIRST sentence: models often emit
// a one-word acknowledgment or a line of empathy first ("Sure! Let me pull that
// up. …" / "I'm so sorry. Let me pull up your order. …"). A handoff line ("let me
// check with the team") must be preserved. So scan the first few sentences, remove
// the FIRST that is pure lookup-narration (and not a handoff), and keep everything
// else — acknowledgment, empathy, the answer — with its original formatting.
const NARRATION_HANDOFF_RE =
  /\b(?:team|someone|colleague|a human|connect|specialist|reach out|get back to you)\b/i;

function sentenceRegex(): RegExp {
  return /[^.!?\n]*(?:[!?]+|(?<!\d)\.(?!\d))+/g;
}

function capitalizeFirstLetter(text: string): string {
  return text.replace(/^(\s*)([a-z])/, (_match, spaces: string, letter: string) =>
    `${spaces}${letter.toUpperCase()}`,
  );
}

function stripLeadingProcessClause(text: string): string {
  const trimmed = text.replace(
    /^\s*(?:the\s+search|the\s+source)\s+didn['’]?t\s+(?:return|surface|find)[^.!?\n]*?\s+[—-]\s+/i,
    '',
  );
  return trimmed === text ? text : capitalizeFirstLetter(trimmed);
}

// Conservative by design: only the first few sentences are scanned (a verb deep in
// a long answer is never touched), only a clear lookup-narration sentence is cut,
// handoffs are spared, and it never removes a sentence that leaves nothing after it
// — so it cannot blank a reply or clip a genuine answer.
export function stripLeadingNarration(text: string): string {
  let current = stripLeadingProcessClause(text);
  for (let removals = 0; removals < 6; removals += 1) {
    const sentenceRe = sentenceRegex();
    let match: RegExpExecArray | null;
    let scanned = 0;
    let removed = false;
    while ((match = sentenceRe.exec(current)) !== null && scanned < 5) {
      scanned += 1;
      const sentence = match[0];
      const isKbPreamble = /\b(?:the|our)\s+kb\b/i.test(sentence);
      const isMetaReplyPreamble =
        /\b(?:the\s+customer\s+is\s+asking|here['’]?s\s+a\s+reply|warm,\s+honest\s+reply|moves\s+things\s+forward|since\s+i\s+don['’]?t\s+have\s+(?:a\s+)?confirmed|no\s+confirmed\s+source\s+tool|in\s+this\s+session|the\s+results\s+here|i['’]?ll\s+let\s+the\s+customer\s+know|routing\s+to|brief\s+intake)\b/i.test(
          sentence,
        );
      if (
        !LEADING_NARRATION_RE.test(sentence) ||
        (NARRATION_HANDOFF_RE.test(sentence) &&
          !isKbPreamble &&
          !isMetaReplyPreamble)
      ) {
        continue;
      }
      const before = current.slice(0, match.index).replace(/\s+$/, '');
      const after = current
        .slice(match.index + sentence.length)
        .replace(/^\s+/, '');
      if (!after) return current; // nothing of substance would remain — leave it alone
      current = before ? `${before} ${after}` : after;
      removed = true;
      break;
    }
    if (!removed) return current;
  }
  return current;
}

const COMPLAINT_EMPATHY_SENTENCE_RE =
  /\b(?:i['’]m\s+so\s+sorry|i\s+am\s+so\s+sorry|sorry|that['’]?s\s+not\s+the\s+experience)\b/i;

export function stripDuplicateComplaintEmpathy(text: string): string {
  const firstSentence = /^\s*[^.!?\n]*[.!?]+/.exec(text);
  if (!firstSentence || !COMPLAINT_EMPATHY_SENTENCE_RE.test(firstSentence[0])) {
    return text;
  }
  const prefix = firstSentence[0].trim();
  let rest = text.slice(firstSentence[0].length);
  for (let removed = 0; removed < 4; removed += 1) {
    const nextSentence = /^\s*[^.!?\n]*[.!?]+/.exec(rest);
    if (!nextSentence || !COMPLAINT_EMPATHY_SENTENCE_RE.test(nextSentence[0])) {
      break;
    }
    rest = rest.slice(nextSentence[0].length);
  }
  const remaining = rest.trimStart();
  return remaining ? `${prefix} ${remaining}` : prefix;
}

const UNSAFE_SPECULATION_SENTENCE_RE =
  /\b(?:(?:deliveries?|delivery)\s+to\s+\d{6}[^.!?\n]*(?:definitely|possible|do\s+deliver|should\s+reach|likely|available)|\d{6}[^.!?\n]*(?:south\s+mumbai|south\s+bombay|worli|bandra)[^.!?\n]*(?:definitely|possible|deliveries?|delivery)|(?:travel|carry|journey)[^.!?\n]*\bdefinitely\b|\bdefinitely\b[^.!?\n]*(?:travel|carry|journey)|(?:gift(?:ing)?\s+)?(?:boxes|packs|variants)[^.!?\n]*\busually\b[^.!?\n]*(?:set\s+sizes|come\s+in|available|work|possible))/i;

export function stripUnsafeSpeculation(text: string): string {
  const sentenceRe = sentenceRegex();
  let match: RegExpExecArray | null;
  let scanned = 0;
  while ((match = sentenceRe.exec(text)) !== null && scanned < 5) {
    scanned += 1;
    const sentence = match[0];
    if (!UNSAFE_SPECULATION_SENTENCE_RE.test(sentence)) continue;
    const before = text.slice(0, match.index).replace(/\s+$/, '');
    const after = text
      .slice(match.index + sentence.length)
      .replace(/^\s+/, '');
    if (!after) return text;
    return before ? `${before} ${after}` : after;
  }
  return text;
}

export function stripPincodeAreaInference(text: string): string {
  return text.replace(
    /\b((?:delivery|deliveries|serviceability|timing)\s+to\s+\d{6})\s+\([^)]*\)/gi,
    '$1',
  );
}

export function replaceUnsafeTravelPromise(text: string): string {
  if (
    !/\b(?:travels?\s+well|travel\s+favourite|train\s+journey|no\s+ice\s+packs?|room\s+temperature|direct\s+sunlight|dry,\s*firm|doesn['’]?t\s+crumble|stays?\s+good|keep\s+it\s+fresh|warm\s+or\s+humid)\b/i.test(
      text,
    )
  ) {
    return text;
  }
  return 'Travel suitability needs team confirmation for that product and journey. The team can confirm the right storage and travel guidance before you leave.';
}

export function normalizeAvailabilityWording(text: string): string {
  return text.replace(/what['’]?s available right now/gi, 'the currently confirmed options');
}

export function normalizeOrderLookupIdentityRequest(text: string): string {
  return text.replace(
    /(?:\s+or\s+)?(?:the\s+)?phone\s+number\s*(?:\/|\s+or\s+)\s*email\s+used\s+at\s+checkout/gi,
    '',
  );
}

export function normalizePromiseWording(text: string): string {
  return text
    .replace(
      /\bwe\s+(?:can['’]?t|cannot)\s+guarantee\s+specific\s+time\s+windows?\s+from\s+here\b/gi,
      'specific time windows need team confirmation',
    )
    .replace(
      /\bwe\s+(?:can['’]?t|cannot)\s+guarantee\s+(?:a\s+|the\s+)?(?:slot|time\s+slot|delivery\s+slot|specific\s+slot|specific\s+time\s+window)[^.!?\n]*/gi,
      'the team can confirm the closest possible slot',
    )
    .replace(
      /\bwe\s+(?:can['’]?t|cannot)\s+guarantee[^.!?\n]*/gi,
      'the team can confirm what is possible',
    );
}

export function normalizeUnsupportedPolicyWording(text: string): string {
  return text
    .replace(
      /\(?\bNo\s+[^.!?\n)]*\b(?:OTP|CVV|UPI\s+PIN|PIN|full\s+card|card\s+details|card\s+number)\b[^.!?\n)]*needed\s+[—-]\s+just\s+the\s+method\s+and\s+the\s+message\.?\)?/gi,
      'Just the payment method and error message are enough.',
    )
    .replace(
      /\bwe\s+don['’]?t\s+take\s+table\s+bookings?\s+through\s+WhatsApp\s+directly\b/gi,
      'the store team can confirm reservation details',
    )
    .replace(
      /\bBSS\s+can['’]?t\s+directly\s+pull\s+that\s+from\s+the\s+platform\b/gi,
      'the team can check what guidance is possible',
    )
    .replace(
      /\bthe\s+platform\s+usually\s+sends\s+it\s+by\s+email\b/gi,
      'the team can check what guidance is possible',
    )
    .replace(
      /\bthe\s+store\s+will\s+confirm\s+the\s+booking\s+for\s+you\b/gi,
      'the store team can confirm reservation details',
    );
}

export function normalizeCustomerHandoffWording(text: string): string {
  return text
    .replace(/\broute\s+this\s+to\s+the\s+team\b/gi, 'pass this to the team')
    .replace(/\brouting\s+this\s+to\s+the\s+team\b/gi, 'passing this to the team')
    .replace(/\broute\s+to\s+the\s+team\b/gi, 'pass it to the team')
    .replace(/\brouting\s+to\s+the\s+team\b/gi, 'passing it to the team')
    .replace(/\bhelp\s+route\s+this\b/gi, 'help pass this to the team')
    .replace(/\broute\s+this\b/gi, 'pass this to the team')
    .replace(/\brouting\s+this\b/gi, 'passing this to the team');
}

export function normalizeUnsupportedMiscPolicyWording(text: string): string {
  return text
    .replace(
      /\bThis\s+looks\s+like\s+spam\.\s+Giving\s+it\s+the\s+standard\s+brief\s+reply\.\s*/gi,
      '',
    )
    .replace(
      /\bBombay\s+Sweet\s+Shop['’]s\s+WhatsApp\s+is\s+here\s+for\s+sweets,\s+gifting,\s+and\s+orders\.\s+Let\s+us\s+know\s+if\s+we\s+can\s+help\s+with\s+any\s+of\s+that!\s*\S?/giu,
      'I can only help with Bombay Sweet Shop orders, gifting, sweets, stores, and cafe questions.',
    )
    .replace(
      /\bso\s+you['’]?re\s+removed\s+from\s+our\s+list\b/gi,
      'so they can review the opt-out request',
    )
    .replace(
      /\byou\s+won['’]?t\s+hear\s+from\s+us\s+unless\s+you\s+reach\s+out\s+first\b/gi,
      'They can confirm the opt-out status',
    )
    .replace(
      /\b(?:to\s+)?ensure\s+you['’]?re\s+reviewed\s+for\s+removal\s+from\s+our\s+messaging\s+list\b/gi,
      'for team review of the opt-out request',
    )
    .replace(
      /\b(?:reach\s+out|reaching\s+out)\s+(?:directly\s+)?through\s+the\s+official\s+BSS\s+website\s+or\s+(?:visit|visiting)\s+(?:one\s+of\s+)?(?:their|our)?\s*stores?\b/gi,
      'share your request here so the team can confirm the right next step',
    )
    .replace(
      /\b(?:through\s+their\s+official\s+website\s+or\s+visiting\s+a\s+store|through\s+the\s+official\s+BSS\s+website\s+or\s+visiting\s+a\s+store)\b/gi,
      'with the BSS team',
    )
    .replace(
      /\bI['’]?d\s+suggest\s+reaching\s+out\s+to\s+the\s+BSS\s+team\s+directly\s+with\s+the\s+BSS\s+team\b/gi,
      'The team can confirm the right hiring contact or next step',
    )
    .replace(
      /\breview\s+and\s+action\b/gi,
      'review',
    )
    .replace(
      /\bthey['’]?ll\s+review\s+it\s+and\s+action\s+it\s+on\s+their\s+end\b/gi,
      'They can review it',
    )
    .replace(
      /\bso\s+they\s+can\s+review\s+it\s+on\s+their\s+end\b/gi,
      'so the team can review it',
    )
    .replace(
      /\bto\s+the\s+team\s+so\s+the\s+team\s+can\s+review\s+it\b/gi,
      'to the team for review',
    )
    .replace(
      /\bthey\s+can\s+review\s+it\s+on\s+their\s+end\b/gi,
      'They can review it',
    )
    .replace(
      /\bfor\s+review\s+so\s+(?:they|the\s+team)\s+can\s+action\s+it\s+on\s+their\s+end\b/gi,
      'for team review',
    )
    .replace(
      /\bthe\s+right\s+person\s+to\s+action\s+it\b/gi,
      'the right person for review',
    )
    .replace(
      /\b(?:so\s+)?(?:they|the\s+team)\s+can\s+action\s+it\s+on\s+their\s+end\b/gi,
      'so the team can review it',
    )
    .replace(
      /\b(?:so\s+)?(?:they|the\s+team)\s+can\s+action\s+(?:the\s+)?(?:request|opt-out|this)\b/gi,
      'so the team can review the request',
    )
    .replace(
      /\bmake\s+sure\s+it['’]?s\s+sorted\b/gi,
      'confirm the next step',
    )
    .replace(
      /\bmake\s+sure\s+the\s+messages\s+stop\b/gi,
      'confirm the next step',
    )
    .replace(
      /\bstop\s+the\s+messages\b/gi,
      'confirm the next step',
    )
    .replace(
      /\bmake\s+sure\s+your\s+preference\s+is\s+applied\b/gi,
      'confirm the next step',
    )
    .replace(
      /\bmake\s+sure\s+it['’]?s\s+actioned(?:\s+properly)?\b/gi,
      'confirm the next step',
    )
    .replace(
      /\bmake\s+sure\s+your\s+request\s+is\s+actioned\b/gi,
      'confirm the next step',
    )
    .replace(
      /\bmake\s+sure\s+(?:your\s+opt-out|the\s+opt-out|this\s+opt-out)\s+is\s+actioned(?:\s+properly)?\b/gi,
      'confirm the next step',
    )
    .replace(
      /\bsort\s+(?:this|it)\s+out\b/gi,
      'confirm the next step',
    )
    .replace(
      /\bCould\s+you\s+confirm\s+the\s+phone\s+number\s+you['’]?re\s+receiving\s+these\s+messages\s+on\?\s*That['’]?ll\s+help\s+the\s+team\s+trace\s+it\s+quickly\.?/gi,
      "I'll pass this chat's contact details to the team so they can trace it.",
    )
    .replace(
      /\bCan\s+I\s+confirm\s+the\s+best\s+number\s+or\s+detail\s+to\s+flag\s+this\s+under\s+[—-]\s+is\s+it\s+the\s+number\s+you['’]?re\s+messaging\s+from\s+right\s+now\?/gi,
      "I'll pass this chat's contact details to the team so they can trace it.",
    )
    .replace(
      /\bCan\s+you\s+confirm\s+the\s+number\s+you['’]?re\s+messaging\s+from\s+is\s+the\s+one\s+you\s+want\s+removed\?/gi,
      "I'll pass this chat's contact details to the team so they can trace it.",
    )
    .replace(
      /\bCould\s+you\s+share\s+the\s+number\s+or\s+email\s+you\s+used\s+when\s+you\s+unsubscribed\?\s*That['’]?ll\s+help\s+the\s+team\s+trace\s+it\s+faster\.?/gi,
      "I'll pass this chat's contact details to the team so they can trace it.",
    )
    .replace(
      /\bCould\s+you\s+share\s+the\s+number\s+or\s+email\s+you\s+used\s+to\s+unsubscribe\?\s*That['’]?ll\s+help\s+the\s+team\s+trace\s+it\s+faster\.?/gi,
      "I'll pass this chat's contact details to the team so they can trace it.",
    )
    .replace(
      /\bCould\s+you\s+confirm\s+the\s+phone\s+number\s+or\s+details\s+on\s+the\s+account,\s+so\s+I\s+can\s+make\s+sure\s+the\s+right\s+one\s+gets\s+flagged\?/gi,
      "I'll pass this chat's contact details to the team so they can trace it.",
    )
    .replace(
      /\bCan\s+I\s+confirm\s+your\s+name\s+or\s+WhatsApp\s+number\s+so\s+I\s+can\s+pass\s+this\s+along\s+to\s+them\s+right\s+away\?/gi,
      "I'll pass this chat's contact details to the team so they can trace it.",
    )
    .replace(
      /\bCould\s+you\s+confirm\s+the\s+number\s+you['’]?d\s+like\s+removed,\s+so\s+I\s+can\s+flag\s+it\s+correctly\?/gi,
      "I'll pass this chat's contact details to the team so they can trace it.",
    );
}

function sanitizeCustomerVisibleOutput(text: string): string {
  return normalizeUnsupportedMiscPolicyWording(
    normalizeCustomerHandoffWording(
      normalizeOrderLookupIdentityRequest(
        normalizeUnsupportedPolicyWording(
          normalizePromiseWording(
            normalizeAvailabilityWording(
              stripUnsafeSpeculation(
                stripPincodeAreaInference(
                  stripDuplicateComplaintEmpathy(
                    stripLeadingNarration(replaceUnsafeTravelPromise(text)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
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
  const trimmed = sanitizeCustomerVisibleOutput(input.text);
  const matchedPattern = findInternalLeak(trimmed);
  if (matchedPattern) {
    input.logger?.warn(
      { conversationJid: input.conversationJid, matchedPattern },
      'Customer-visible output guard replaced a reply that leaked internal implementation detail',
    );
    return CUSTOMER_VISIBLE_DECLINE_MESSAGE;
  }
  if (trimmed !== input.text) {
    input.logger?.warn(
      { conversationJid: input.conversationJid },
      'Customer-visible output guard trimmed unsafe customer-facing wording from a reply',
    );
  }
  return trimmed;
}
