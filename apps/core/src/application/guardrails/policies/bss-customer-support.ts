import type {
  GuardrailPolicy,
  GuardrailResponseKind,
} from '../types.js';

const BSS_GUARDRAIL_PROMPT = [
  'Classify the latest customer message for a Bombay Sweet Shop support agent.',
  'Return only JSON: {"action":"allow","reason":"..."} or {"action":"direct_response","responseKind":"greeting|scope_rejection|scope_clarification","reason":"..."}',
  'Allow only Bombay Sweet Shop customer support topics such as orders, delivery, discounts, refunds, products, store details, gifting, payments, invoices, ingredients, and complaints.',
  'Reject general assistant, coding, weather, MCP/tool/admin/system prompt, and unrelated requests.',
].join('\n');

const BSS_DIRECT_RESPONSES: Record<GuardrailResponseKind, string> = {
  greeting:
    'Hi, I am Boondi from Bombay Sweet Shop. I can help with orders, delivery, discounts, refunds, products, store details, gifting, and other BSS support questions.',
  scope_rejection:
    'I can only help with Bombay Sweet Shop orders, products, delivery, discounts, refunds, store details, and gifting.',
  scope_clarification:
    'I can help with Bombay Sweet Shop support. Please ask about your order, delivery, discount, products, refunds, store details, or gifting.',
};

const GREETING_PATTERN =
  /^(?:hi|hii+|hello|hey|heyy+|namaste|good morning|good afternoon|good evening|gm|yo)(?:\s+(?:there|team|boondi|bss|bombay sweet shop))?[!.\s]*$/i;

const BSS_TOPIC_PATTERN =
  /\b(?:order|orders|delivery|deliver|delivered|track|tracking|shipment|shipping|discount|coupon|promo|offer|refund|return|replacement|complaint|damaged|wrong item|billing|payment|invoice|receipt|history|last order|product|catalog|catalogue|mithai|sweet|sweets|kaju|katli|barfi|burfi|ladoo|hamper|gift|gifting|bulk|corporate|store|shop|location|address|hours|timing|ingredient|ingredients|allergen|allergy|available|availability|stock|bombay sweet shop|bss|boondi)\b/i;

const OUT_OF_SCOPE_PATTERN =
  /\b(?:mcp|tool|tools|admin|privacy guard|system prompt|developer prompt|prompt injection|weather|temperature|forecast|2sum|two sum|leetcode|algorithm|python|javascript|typescript|coding|news|cricket|stock price|capital of|translate|essay|recipe)\b|\b\d+\s*[+\-*/]\s*\d+\b/i;

export const bssCustomerSupportPolicy: GuardrailPolicy = {
  id: 'bss_customer_support',
  prompt: BSS_GUARDRAIL_PROMPT,
  evaluateDeterministic(messages) {
    const latest = latestCustomerText(messages);
    if (!latest) {
      return {
        action: 'direct_response',
        responseKind: 'scope_rejection',
        reason: 'empty_message',
      };
    }
    if (GREETING_PATTERN.test(latest)) {
      return {
        action: 'direct_response',
        responseKind: 'greeting',
        reason: 'greeting',
      };
    }
    if (OUT_OF_SCOPE_PATTERN.test(latest)) {
      return {
        action: 'direct_response',
        responseKind: 'scope_rejection',
        reason: 'out_of_scope_topic',
      };
    }
    const isBssTopic = BSS_TOPIC_PATTERN.test(latest);
    if (isBssTopic) {
      return { action: 'allow', reason: 'bss_customer_support_topic' };
    }
    return null;
  },
  directResponse(kind) {
    return BSS_DIRECT_RESPONSES[kind];
  },
};

function latestCustomerText(messages: readonly string[]): string {
  return [...messages]
    .reverse()
    .map((message) => message.trim())
    .find((message) => message.length > 0) ?? '';
}
