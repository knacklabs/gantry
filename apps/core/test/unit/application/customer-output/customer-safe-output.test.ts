import { describe, expect, it, vi } from 'vitest';

import {
  findInternalLeak,
  guardCustomerVisibleOutput,
  normalizeAvailabilityWording,
  normalizeCustomerHandoffWording,
  normalizeOrderLookupIdentityRequest,
  normalizePromiseWording,
  normalizeUnsupportedMiscPolicyWording,
  normalizeUnsupportedPolicyWording,
  replaceUnsafeTravelPromise,
  stripPincodeAreaInference,
  stripDuplicateComplaintEmpathy,
  stripLeadingNarration,
  stripUnsafeSpeculation,
} from '@core/application/customer-output/customer-safe-output.js';
import { CUSTOMER_VISIBLE_DECLINE_MESSAGE } from '@core/shared/user-visible-messages.js';

const CLEAN =
  'Your order #BSS-2847 is out for delivery and should arrive today.';
const LEAKY =
  'The MCP tool returned PRIVACY_GUARD_FAILED, so check the Shopify Admin panel.';

describe('guardCustomerVisibleOutput', () => {
  it('passes clean customer replies through unchanged', () => {
    expect(
      guardCustomerVisibleOutput({
        text: CLEAN,
        persona: 'sales',
        conversationJid: 'wa:917003705584',
      }),
    ).toBe(CLEAN);
  });

  it('replaces a reply that leaks internal detail and logs the hit', () => {
    const logger = { warn: vi.fn() };

    const result = guardCustomerVisibleOutput({
      text: LEAKY,
      persona: 'sales',
      conversationJid: 'wa:917003705584',
      logger,
    });

    expect(result).toBe(CUSTOMER_VISIBLE_DECLINE_MESSAGE);
    expect(result).not.toMatch(/mcp|privacy[ _-]?guard|shopify admin/i);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'wa:917003705584' }),
      expect.stringContaining('internal implementation detail'),
    );
  });

  it('does not redact developer-persona output', () => {
    expect(
      guardCustomerVisibleOutput({
        text: LEAKY,
        persona: 'developer',
        conversationJid: 'app:ops',
      }),
    ).toBe(LEAKY);
  });

  it('guards by default when persona is unset (fail-safe)', () => {
    expect(
      guardCustomerVisibleOutput({
        text: LEAKY,
        persona: undefined,
        conversationJid: 'wa:917003705584',
      }),
    ).toBe(CUSTOMER_VISIBLE_DECLINE_MESSAGE);
  });

  it('sanitizes a removable KB preamble before internal-leak redaction', () => {
    const logger = { warn: vi.fn() };

    const result = guardCustomerVisibleOutput({
      text: 'The KB says nearest-store details need team confirmation. The team can confirm the nearest BSS outlet to Worli for you.',
      persona: 'sales',
      conversationJid: 'wa:917003705584',
      logger,
    });

    expect(result).toBe(
      'The team can confirm the nearest BSS outlet to Worli for you.',
    );
    expect(result).not.toMatch(/\bKB\b/i);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'wa:917003705584' }),
      expect.stringContaining('unsafe customer-facing wording'),
    );
  });

  it('sanitizes an "our KB" store preamble before internal-leak redaction', () => {
    const logger = { warn: vi.fn() };

    const result = guardCustomerVisibleOutput({
      text: "The store locations in our KB aren't filled in yet, so I can't confirm the nearest outlet from here. Nearest BSS store to Worli — the team can confirm that for you. Want me to pass your area along to them?",
      persona: 'sales',
      conversationJid: 'wa:917003705584',
      logger,
    });

    expect(result).toBe(
      'Nearest BSS store to Worli — the team can confirm that for you. Want me to pass your area along to them?',
    );
    expect(result).not.toMatch(/\bKB\b/i);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'wa:917003705584' }),
      expect.stringContaining('unsafe customer-facing wording'),
    );
  });

  it('still redacts an internal marker that remains after sanitization', () => {
    const logger = { warn: vi.fn() };

    const result = guardCustomerVisibleOutput({
      text: 'The team can confirm it from the KB.',
      persona: 'sales',
      conversationJid: 'wa:917003705584',
      logger,
    });

    expect(result).toBe(CUSTOMER_VISIBLE_DECLINE_MESSAGE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationJid: 'wa:917003705584',
        matchedPattern: '\\bKB\\b',
      }),
      expect.stringContaining('internal implementation detail'),
    );
  });

  it('does not flag innocent words that are not internal markers', () => {
    expect(
      findInternalLeak('Can I get a gift hamper delivered tomorrow?'),
    ).toBeUndefined();
  });

  it('flags the added internal markers a customer reply must never contain', () => {
    expect(
      findInternalLeak('I pulled it from our Shopify integration.'),
    ).toBeDefined();
    expect(
      findInternalLeak("The knowledge base doesn't have prices filled in yet."),
    ).toBeDefined();
    expect(findInternalLeak("The Bandra timings aren't in the KB yet.")).toBeDefined();
    expect(
      findInternalLeak('You can look it up in the admin dashboard.'),
    ).toBeDefined();
    expect(
      findInternalLeak("That's a privacy/security control on our side."),
    ).toBeDefined();
  });
});

describe('normalizeUnsupportedMiscPolicyWording', () => {
  it('removes unsupported opt-out action wording', () => {
    expect(
      normalizeUnsupportedMiscPolicyWording(
        "I'll pass your contact details to our team for review so they can action it on their end.",
      ),
    ).toBe("I'll pass your contact details to our team for team review.");
  });
});

describe('stripLeadingNarration', () => {
  it('trims a lookup-narration sentence glued to the answer', () => {
    expect(
      stripLeadingNarration(
        "I'll look up your order history now.Your last order is #109260.",
      ),
    ).toBe('Your last order is #109260.');
  });

  it('trims a "let me check" preamble before the answer', () => {
    expect(
      stripLeadingNarration('Let me check that for you. Your order shipped.'),
    ).toBe('Your order shipped.');
  });

  it('trims a "looking up … now" preamble', () => {
    expect(
      stripLeadingNarration(
        'Looking up the catalogue now.We have dark chocolate.',
      ),
    ).toBe('We have dark chocolate.');
  });

  it('leaves a clean answer untouched', () => {
    const clean = 'Your last order is #109260, delivered to Mumbai.';
    expect(stripLeadingNarration(clean)).toBe(clean);
  });

  it('leaves an empathy-led reply untouched', () => {
    const empathy =
      "I'm really sorry — that's not what we wanted for you. Let me sort this.";
    expect(stripLeadingNarration(empathy)).toBe(empathy);
  });

  it('does not trip on a handoff "let me get someone"', () => {
    const handoff = "Let me get someone for you now. They'll have everything.";
    expect(stripLeadingNarration(handoff)).toBe(handoff);
  });

  it('never blanks a reply that is only the narration sentence', () => {
    const onlyNarration = "I'll look up your order.";
    expect(stripLeadingNarration(onlyNarration)).toBe(onlyNarration);
  });

  it('trims a narration sentence that follows a short acknowledgment', () => {
    expect(
      stripLeadingNarration(
        'Sure! Let me pull that up right away.Order #109260 is delivered.',
      ),
    ).toBe('Sure! Order #109260 is delivered.');
  });

  it('trims a narration sentence after a "yes we do" opener', () => {
    expect(
      stripLeadingNarration(
        'Yes, we do! Let me pull up what we have.We have dark chocolate kaju katli.',
      ),
    ).toBe('Yes, we do! We have dark chocolate kaju katli.');
  });

  it('trims the lookup narration but KEEPS the empathy in a complaint reply', () => {
    expect(
      stripLeadingNarration(
        "I'm so sorry — that's genuinely not okay. Let me pull up your order. It shows delivered on 28 May.",
      ),
    ).toBe(
      "I'm so sorry — that's genuinely not okay. It shows delivered on 28 May.",
    );
  });

  it('does not trim a handoff that follows an acknowledgment', () => {
    const handoff = 'Sure! Let me check with the team and get back to you.';
    expect(stripLeadingNarration(handoff)).toBe(handoff);
  });

  it('trims a "searching … now" product-lookup preamble', () => {
    expect(
      stripLeadingNarration(
        'Searching for kaju katli now.We have dark chocolate kaju katli for ₹515.',
      ),
    ).toBe('We have dark chocolate kaju katli for ₹515.');
  });

  it('trims an "I\'ll search" preamble after an acknowledgment', () => {
    expect(
      stripLeadingNarration(
        "Yes! I'll search the catalogue for that.We have it in stock.",
      ),
    ).toBe('Yes! We have it in stock.');
  });

  it('trims an "I need to search" preamble before a product answer', () => {
    expect(
      stripLeadingNarration(
        'I need to search for Kaju Katli products first.हाँ, काजू कतली है.',
      ),
    ).toBe('हाँ, काजू कतली है.');
  });

  it('trims an "I need to look up" preamble before an order answer', () => {
    expect(
      stripLeadingNarration(
        "I need to look up the customer's order history. Let me do that now.Your last order was #109260.",
      ),
    ).toBe('Your last order was #109260.');
  });

  it('trims multiple search-narration sentences before the product answer', () => {
    expect(
      stripLeadingNarration(
        "That search only returned one result and it's currently out of stock. Let me try a broader search.These results are packaging/gift bags rather than the actual sweets. Let me search specifically for mithai.Of the available products right now, here's the one that's genuinely worth celebrating with.",
      ),
    ).toBe(
      "Of the available products right now, here's the one that's genuinely worth celebrating with.",
    );
  });

  it('trims a leading tool-availability sentence before the answer', () => {
    expect(
      stripLeadingNarration(
        'The tools are now available. आपका सबसे हालिया ऑर्डर डिलीवर हो चुका है!',
      ),
    ).toBe('आपका सबसे हालिया ऑर्डर डिलीवर हो चुका है!');
  });

  it('trims a leading KB-confirmation preamble before the customer answer', () => {
    expect(
      stripLeadingNarration(
        "The KB confirms that discount-window questions need the exact code. Which offer or code are you trying to use?",
      ),
    ).toBe('Which offer or code are you trying to use?');
  });

  it('trims a leading KB-confirmation preamble even when it mentions team confirmation', () => {
    expect(
      stripLeadingNarration(
        "The KB confirms that storage guidance needs team confirmation. Product-specific storage guidance needs team confirmation.",
      ),
    ).toBe('Product-specific storage guidance needs team confirmation.');
  });

  it('trims a leading KB preamble even without the word confirms', () => {
    expect(
      stripLeadingNarration(
        'The KB is clear — I do not have confirmed sugar-free details here. Great question! I need the team to confirm options.',
      ),
    ).toBe('Great question! I need the team to confirm options.');
  });

  it('trims a leading context-analysis preamble', () => {
    expect(
      stripLeadingNarration(
        'The context here is light. Of course! Which product or box did you mean?',
      ),
    ).toBe('Of course! Which product or box did you mean?');
  });

  it('trims search miss and missing-context reasoning before the customer question', () => {
    expect(
      stripLeadingNarration(
        "The search didn't return a specific 12-piece box. Since I don't have context on what product they were originally looking at, I'll ask for that context before guiding them. Which box were you looking at?",
      ),
    ).toBe('Which box were you looking at?');
  });

  it('trims search-surface and meta-reply narration before the customer answer', () => {
    expect(
      stripLeadingNarration(
        "The search didn't surface a 12-piece box specifically. Since there's no prior context on what they were originally looking at, here's a reply that acknowledges their ask and guides them forward: Of course! Which product were you looking at?",
      ),
    ).toBe('Which product were you looking at?');
  });

  it('trims source and reply-contract narration before the customer answer', () => {
    expect(
      stripLeadingNarration(
        "The source didn't return a specific 12-piece box. Honouring the reply contract, I'll lead with the website and share what's listed, while being honest that an exact 12-piece box wasn't confirmed. A smaller box with exactly 12 pieces isn't something I can confirm from here.",
      ),
    ).toBe(
      "A smaller box with exactly 12 pieces isn't something I can confirm from here.",
    );
  });

  it('trims confirmed-result reasoning before the customer answer', () => {
    expect(
      stripLeadingNarration(
        "Since I don't have a confirmed 12-piece box in the results, I'll be honest about that and route to the team for customisation feasibility. A 12-piece box isn't something I can confirm from here.",
      ),
    ).toBe("A 12-piece box isn't something I can confirm from here.");
  });

  it('trims a search-process clause without clipping decimal product names', () => {
    expect(
      stripLeadingNarration(
        "The search didn't surface a classic Kaju Katli box — the closest match is our **Indie Bites: 54.5% Dark Chocolate Kaju Katli** (approx. 140g, ₹515), but the product details don't mention a specific piece count. For the exact piece count, the team can confirm.",
      ),
    ).toBe(
      "The closest match is our **Indie Bites: 54.5% Dark Chocolate Kaju Katli** (approx. 140g, ₹515), but the product details don't mention a specific piece count. For the exact piece count, the team can confirm.",
    );
  });

  it('trims delivery source-tool reasoning before the customer question', () => {
    expect(
      stripLeadingNarration(
        "Delivery serviceability for 400050 needs checkout or team confirmation — there's no confirmed source tool for pincode coverage in this session. Also, no specific product was mentioned in the message, so I'll ask about that too. Could you let me know which product you'd like delivered?",
      ),
    ).toBe("Could you let me know which product you'd like delivered?");
  });

  it('trims result-analysis narration before custom-pack guidance', () => {
    expect(
      stripLeadingNarration(
        "The results here are general products, not a confirmed 12-piece gift box option. I'll let the customer know I need a bit more context and point them to the website — without making any stock or availability promises. For an exact 12-piece box, the website is the best place to check what's currently listed.",
      ),
    ).toBe(
      "For an exact 12-piece box, the website is the best place to check what's currently listed.",
    );
  });

  it('trims prior-product context analysis before the customer question', () => {
    expect(
      stripLeadingNarration(
        'That said, without knowing what product they were originally looking at, I should ask. Since I have no prior context here, I will respond naturally. Of course! Which sweet did you have in mind?',
      ),
    ).toBe('Of course! Which sweet did you have in mind?');
  });

  it('trims continuation-analysis narration before the direct product question', () => {
    expect(
      stripLeadingNarration(
        "This message seems to be a continuation of a product/order conversation, but I don't have the prior context about what was originally ordered. Let me ask for the missing detail.\n\nTo help with a 12-piece box, could you share which product or box you had in mind?",
      ),
    ).toBe(
      'To help with a 12-piece box, could you share which product or box you had in mind?',
    );
  });

  it('trims generic discount-window rules before asking for the code', () => {
    expect(
      stripLeadingNarration(
        "The offer terms are what matter here — some codes apply on order date, others on delivery date, and I can't confirm which without the details. Could you share the discount code or offer name?",
      ),
    ).toBe('Could you share the discount code or offer name?');
  });

  it('trims routing/process narration before a customer-facing handoff', () => {
    expect(
      stripLeadingNarration(
        "Since piece count and box size details need confirmed source data, I'll route this correctly. Could you share which product or sweet you had in mind?",
      ),
    ).toBe('Could you share which product or sweet you had in mind?');
  });

  it('trims clarifying-question process narration before the direct question', () => {
    expect(
      stripLeadingNarration(
        "That said, box size availability isn't something I can confirm without a product — let me ask a quick clarifying question. Of course! Which product or box did you mean?",
      ),
    ).toBe('Of course! Which product or box did you mean?');
  });

  it('trims meta-reply narration before the actual customer reply', () => {
    expect(
      stripLeadingNarration(
        "The customer is asking about a specific box size, which needs product or team confirmation. Since I don't have the prior conversation context, I'll give a warm, honest reply that moves things forward. Smaller boxes depend on the specific item. Which sweet were you looking at?",
      ),
    ).toBe(
      'Smaller boxes depend on the specific item. Which sweet were you looking at?',
    );
  });

  it('trims a "let me look that up" preamble (object between verb and "up")', () => {
    expect(
      stripLeadingNarration(
        'Let me look that up for you.Your most recent order is #109260.',
      ),
    ).toBe('Your most recent order is #109260.');
  });

  it('trims an "I\'ll pull it up" preamble', () => {
    expect(
      stripLeadingNarration("I'll pull it up.Order #109260 shipped yesterday."),
    ).toBe('Order #109260 shipped yesterday.');
  });

  it('trims corporate-gifting process narration before the customer reply', () => {
    expect(
      stripLeadingNarration(
        "This is a clear corporate gifting lead — 80 pieces, GST invoice, and logo branding are all strong B2B signals. Let me capture what's needed and route warmly. 80 employee gifts with branding and a GST invoice need team confirmation.",
      ),
    ).toBe(
      '80 employee gifts with branding and a GST invoice need team confirmation.',
    );
  });

  it('trims corporate-signal routing narration before the intake ask', () => {
    expect(
      stripLeadingNarration(
        'This is a clear corporate/bulk signal — 80 pieces, GST, and logo branding. Routing to the gifting team with a brief intake. A few quick details so I can pass a complete brief to our gifting team?',
      ),
    ).toBe(
      'A few quick details so I can pass a complete brief to our gifting team?',
    );
  });

  it('trims bulk/corporate brief narration before the customer reply', () => {
    expect(
      stripLeadingNarration(
        "This is a clear bulk/corporate brief — 80 pieces, GST invoice, and logo branding. 80 employee gifts with GST and branding — that's exactly what our gifting team handles.",
      ),
    ).toBe(
      "80 employee gifts with GST and branding — that's exactly what our gifting team handles.",
    );
  });

  it('trims corporate brief capture narration before the customer reply', () => {
    expect(
      stripLeadingNarration(
        "This is a clear corporate/bulk gifting signal — 80 pieces, GST invoice, logo branding. Capturing the brief and asking only for what's missing. 80 employee gifts with GST and logo branding — lovely brief to work with!",
      ),
    ).toBe(
      '80 employee gifts with GST and logo branding — lovely brief to work with!',
    );
  });

  it('trims order-request classifier narration before the customer ask', () => {
    expect(
      stripLeadingNarration(
        "This is a delivery date change request — I'll acknowledge and ask for the order number. Happy to pass that request to the team! Could you share your order number?",
      ),
    ).toBe(
      'Happy to pass that request to the team! Could you share your order number?',
    );
  });
});

describe('stripUnsafeSpeculation', () => {
  it('trims an unverified delivery-confidence sentence and keeps the useful ask', () => {
    expect(
      stripUnsafeSpeculation(
        "Deliveries to 400050 (South Mumbai) are definitely possible — though I'd want to confirm tomorrow evening works for the timeline. Could you share what you'd like to order and the quantity?",
      ),
    ).toBe("Could you share what you'd like to order and the quantity?");
  });

  it('trims custom-pack usually-language and keeps team confirmation wording', () => {
    expect(
      stripUnsafeSpeculation(
        "We don't currently have a 12-piece box listed on the website. Our gifting boxes usually come in set sizes — the team can confirm what's closest to what you're looking for. Could you share what occasion this is for?",
      ),
    ).toBe(
      "We don't currently have a 12-piece box listed on the website. Could you share what occasion this is for?",
    );
  });

  it('does not blank a reply that only has the unsafe sentence', () => {
    const only =
      'Deliveries to 400050 are definitely possible for tomorrow evening.';
    expect(stripUnsafeSpeculation(only)).toBe(only);
  });

  it('trims a definite travel-confidence sentence and keeps confirmation guidance', () => {
    expect(
      stripUnsafeSpeculation(
        "Kaju Katli is definitely a travel favourite! That said, I can't confirm the exact shelf life or travel-specific guidance from here.",
      ),
    ).toBe(
      "That said, I can't confirm the exact shelf life or travel-specific guidance from here.",
    );
  });
});

describe('stripPincodeAreaInference', () => {
  it('removes inferred area labels after delivery pincodes', () => {
    expect(
      stripPincodeAreaInference(
        "Delivery to 400050 (Bandra West) would need to be confirmed at checkout — I can't verify live serviceability from here.",
      ),
    ).toBe(
      "Delivery to 400050 would need to be confirmed at checkout — I can't verify live serviceability from here.",
    );
  });
});

describe('replaceUnsafeTravelPromise', () => {
  it('replaces unsupported travel tips with team-confirmation guidance', () => {
    expect(
      replaceUnsafeTravelPromise(
        "Yes, absolutely — Kaju Katli travels well! It's dry, firm, and doesn't crumble easily, so it's a great choice for a train journey.",
      ),
    ).toBe(
      'Travel suitability needs team confirmation for that product and journey. The team can confirm the right storage and travel guidance before you leave.',
    );
  });
});

describe('normalizeAvailabilityWording', () => {
  it('removes right-now availability phrasing', () => {
    expect(
      normalizeAvailabilityWording(
        "The team can share what's available right now.",
      ),
    ).toBe('The team can share the currently confirmed options.');
  });
});

describe('normalizeOrderLookupIdentityRequest', () => {
  it('removes phone/email fallback from order lookup requests', () => {
    expect(
      normalizeOrderLookupIdentityRequest(
        "I'd be happy to look up the order! Could you share your order number or the phone number/email used at checkout?",
      ),
    ).toBe(
      "I'd be happy to look up the order! Could you share your order number?",
    );
  });

  it('also handles phone or email wording without a slash', () => {
    expect(
      normalizeOrderLookupIdentityRequest(
        'Could you share your order number or the phone number or email used at checkout?',
      ),
    ).toBe('Could you share your order number?');
  });
});

describe('normalizePromiseWording', () => {
  it('removes negative guarantee wording from delivery-slot replies', () => {
    expect(
      normalizePromiseWording(
        "Delivery slot requests need team confirmation — we can't guarantee specific time windows from here.",
      ),
    ).toBe(
      'Delivery slot requests need team confirmation — specific time windows need team confirmation.',
    );
  });

  it('removes shorter negative guarantee wording from slot replies', () => {
    expect(
      normalizePromiseWording(
        "Specific delivery time windows need team confirmation — we can't guarantee a slot.",
      ),
    ).toBe(
      'Specific delivery time windows need team confirmation — the team can confirm the closest possible slot.',
    );
  });

  it('removes arbitrary negative guarantee clauses', () => {
    expect(
      normalizePromiseWording(
        "Specific delivery time slots need team confirmation — we can't guarantee a window at checkout.",
      ),
    ).toBe(
      'Specific delivery time slots need team confirmation — the team can confirm what is possible.',
    );
  });
});

describe('normalizeUnsupportedPolicyWording', () => {
  it('removes sensitive payment credential examples from customer replies', () => {
    expect(
      normalizeUnsupportedPolicyWording(
        '(No OTP, PIN, or card details needed — just the method and the message.)',
      ),
    ).toBe('Just the payment method and error message are enough.');
  });

  it('removes unsupported WhatsApp reservation policy wording', () => {
    expect(
      normalizeUnsupportedPolicyWording(
        "The store/team can confirm reservation details — we don't take table bookings through WhatsApp directly.",
      ),
    ).toBe(
      'The store/team can confirm reservation details — the store team can confirm reservation details.',
    );
  });

  it('removes unsupported aggregator platform-access wording', () => {
    expect(
      normalizeUnsupportedPolicyWording(
        "For a Swiggy order bill, BSS can't directly pull that from the platform — but the team can check.",
      ),
    ).toBe(
      'For a Swiggy order bill, the team can check what guidance is possible — but the team can check.',
    );
  });

  it('removes unsupported aggregator invoice-delivery wording', () => {
    expect(
      normalizeUnsupportedPolicyWording(
        'For a Swiggy invoice, the platform usually sends it by email — but the team can check.',
      ),
    ).toBe(
      'For a Swiggy invoice, the team can check what guidance is possible — but the team can check.',
    );
  });

  it('softens unsupported reservation confirmation wording', () => {
    expect(
      normalizeUnsupportedPolicyWording(
        'The store will confirm the booking for you.',
      ),
    ).toBe('the store team can confirm reservation details.');
  });
});

describe('normalizeCustomerHandoffWording', () => {
  it('replaces internal routing wording with customer-facing handoff wording', () => {
    expect(
      normalizeCustomerHandoffWording(
        'A quick follow-up needed before I can route this to the team.',
      ),
    ).toBe('A quick follow-up needed before I can pass this to the team.');

    expect(
      normalizeCustomerHandoffWording(
        'Swiggy orders can be tricky for invoices — happy to help route this.',
      ),
    ).toBe(
      'Swiggy orders can be tricky for invoices — happy to help pass this to the team.',
    );
  });
});

describe('normalizeUnsupportedMiscPolicyWording', () => {
  it('softens unsupported opt-out completion claims', () => {
    expect(
      normalizeUnsupportedMiscPolicyWording(
        "I'll pass this to the team right away so you're removed from our list. You won't hear from us unless you reach out first. They can review and action it and make sure it's sorted. They'll review it and action it on their end and make sure your preference is applied. Please make sure it's actioned properly.",
      ),
    ).toBe(
      "I'll pass this to the team right away so they can review the opt-out request. They can confirm the opt-out status. They can review it and confirm the next step. They can review it and confirm the next step. Please confirm the next step.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "This looks like spam. Giving it the standard brief reply.\n\nBombay Sweet Shop's WhatsApp is here for sweets, gifting, and orders. Let us know if we can help with any of that!",
      ),
    ).toBe(
      'I can only help with Bombay Sweet Shop orders, gifting, sweets, stores, and cafe questions.',
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "I'll pass your contact details to our team right away so they can review it on their end.",
      ),
    ).toBe(
      "I'll pass your contact details to our team right away so the team can review it.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "I'll pass your details to the team so the team can review it.",
      ),
    ).toBe("I'll pass your details to the team for review.");

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "The contact details here will be shared with the right person to action it.",
      ),
    ).toBe(
      'The contact details here will be shared with the right person for review.',
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "I'll pass this to our team to check what happened and make sure your opt-out is actioned properly.",
      ),
    ).toBe(
      "I'll pass this to our team to check what happened and confirm the next step.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "I'll pass this to the team to check what happened and make sure your opt-out is actioned.",
      ),
    ).toBe(
      "I'll pass this to the team to check what happened and confirm the next step.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "I'll pass it along to ensure you're reviewed for removal from our messaging list.",
      ),
    ).toBe(
      "I'll pass it along for team review of the opt-out request.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "The team will look into why the opt-out didn't take effect and sort this out.",
      ),
    ).toBe(
      "The team will look into why the opt-out didn't take effect and confirm the next step.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        'They can check what happened and sort it out.',
      ),
    ).toBe('They can check what happened and confirm the next step.');

    expect(
      normalizeUnsupportedMiscPolicyWording(
        'They can check what happened and make sure the messages stop.',
      ),
    ).toBe(
      'They can check what happened and confirm the next step.',
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        'They can check what happened and stop the messages.',
      ),
    ).toBe(
      'They can check what happened and confirm the next step.',
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "The team can review your opt-out request and make sure it's actioned.",
      ),
    ).toBe(
      'The team can review your opt-out request and confirm the next step.',
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        'The team can check what happened and make sure your request is actioned.',
      ),
    ).toBe(
      'The team can check what happened and confirm the next step.',
    );
  });

  it('uses Interakt contact context instead of asking for phone again', () => {
    expect(
      normalizeUnsupportedMiscPolicyWording(
        "Could you confirm the phone number you're receiving these messages on? That'll help the team trace it quickly.",
      ),
    ).toBe(
      "I'll pass this chat's contact details to the team so they can trace it.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "Can I confirm the best number or detail to flag this under — is it the number you're messaging from right now?",
      ),
    ).toBe(
      "I'll pass this chat's contact details to the team so they can trace it.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "Can you confirm the number you're messaging from is the one you want removed?",
      ),
    ).toBe(
      "I'll pass this chat's contact details to the team so they can trace it.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "Could you share the number or email you used when you unsubscribed? That'll help the team trace it faster.",
      ),
    ).toBe(
      "I'll pass this chat's contact details to the team so they can trace it.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "Could you share the number or email you used to unsubscribe? That'll help the team trace it faster.",
      ),
    ).toBe(
      "I'll pass this chat's contact details to the team so they can trace it.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        'Could you confirm the phone number or details on the account, so I can make sure the right one gets flagged?',
      ),
    ).toBe(
      "I'll pass this chat's contact details to the team so they can trace it.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        'Can I confirm your name or WhatsApp number so I can pass this along to them right away?',
      ),
    ).toBe(
      "I'll pass this chat's contact details to the team so they can trace it.",
    );

    expect(
      normalizeUnsupportedMiscPolicyWording(
        "Could you confirm the number you'd like removed, so I can flag it correctly?",
      ),
    ).toBe(
      "I'll pass this chat's contact details to the team so they can trace it.",
    );
  });

  it('removes unsupported website-or-store routes for franchise questions', () => {
    expect(
      normalizeUnsupportedMiscPolicyWording(
        'You can reach out through the official BSS website or visit one of their stores to connect with the right person.',
      ),
    ).toBe(
      'You can share your request here so the team can confirm the right next step to connect with the right person.',
    );
  });

  it('removes unsupported website-or-store routes for job questions', () => {
    expect(
      normalizeUnsupportedMiscPolicyWording(
        "For job enquiries, I'd suggest reaching out to the BSS team directly through their official website or visiting a store.",
      ),
    ).toBe(
      'For job enquiries, The team can confirm the right hiring contact or next step.',
    );
  });
});

describe('stripDuplicateComplaintEmpathy', () => {
  it('keeps one complaint empathy opener and removes stacked duplicate apology sentences', () => {
    expect(
      stripDuplicateComplaintEmpathy(
        "I'm so sorry — a crushed box and broken sweets is genuinely not okay, and I completely understand why you're upset. That's not the experience we want for you at all.I'm so sorry — receiving a crushed box and broken sweets is really upsetting, and I'm sorry this happened.\n\nYour order #109260 shows as delivered on 28 May.",
      ),
    ).toBe(
      "I'm so sorry — a crushed box and broken sweets is genuinely not okay, and I completely understand why you're upset. Your order #109260 shows as delivered on 28 May.",
    );
  });

  it('leaves a single empathy opener untouched', () => {
    const clean =
      "I'm so sorry — a crushed box and broken sweets is genuinely not okay. Your order #109260 shows as delivered on 28 May.";

    expect(stripDuplicateComplaintEmpathy(clean)).toBe(clean);
  });
});

describe('guardCustomerVisibleOutput narration trimming', () => {
  it('trims the narration preamble and logs it', () => {
    const logger = { warn: vi.fn() };
    const result = guardCustomerVisibleOutput({
      text: "I'll look up your order now.Your last order is #109260.",
      persona: 'sales',
      conversationJid: 'wa:917003705584',
      logger,
    });
    expect(result).toBe('Your last order is #109260.');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'wa:917003705584' }),
      expect.stringContaining('unsafe customer-facing wording'),
    );
  });
});
