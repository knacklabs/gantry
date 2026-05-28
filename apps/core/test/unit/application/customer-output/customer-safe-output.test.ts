import { describe, expect, it, vi } from 'vitest';

import {
  findInternalLeak,
  guardCustomerVisibleOutput,
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

  it('does not flag innocent words that are not internal markers', () => {
    expect(
      findInternalLeak('Can I get a gift hamper delivered tomorrow?'),
    ).toBeUndefined();
  });
});
