import { describe, expect, it } from 'vitest';

import { sanitizeOutboundLlmText } from '@core/memory/sensitive-material.js';

describe('sensitive material sanitizer', () => {
  it('continues scanning mixed content after replacing known secret markers', () => {
    const knownSecret = 'sk-ant-abcdeabcdeabcdeabcdeabcde';
    const opaqueToken = 'A9xQ7mN2pR5sT8uV1wX4yZ6aB3cD5eF7gH9iJ0kL2';

    const sanitized = sanitizeOutboundLlmText(
      `api_key=${knownSecret} opaque material ${opaqueToken}`,
    );

    expect(sanitized).toMatchObject({
      text: '[REDACTED_POTENTIALLY_SENSITIVE]',
      redacted: true,
      blocked: true,
      reason: 'high_entropy_credential_like_token',
    });
  });
});
