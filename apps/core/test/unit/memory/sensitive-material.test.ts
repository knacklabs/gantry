import { describe, expect, it } from 'vitest';

import { sanitizeOutboundLlmText } from '@core/shared/sensitive-material.js';

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

  it('does not block ordinary long file paths as secrets', () => {
    const commands = [
      'ls /private/tmp/claude-501/-Users-x/c77e1f98-77f6-4164-b2e1-6ac49adb637b/scratchpad',
      'grep -rn foo /Users/x/dist.bak-l2prev/x9aB3cD5eF7gH9iJ0kL2mN4pQ6',
      'node /Users/foo/project2/build-output/bundle.min.js',
    ];
    for (const command of commands) {
      const sanitized = sanitizeOutboundLlmText(command);
      expect(sanitized.blocked).toBe(false);
      expect(sanitized.text).toBe(command);
    }
  });

  it('still masks real secrets', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(sanitizeOutboundLlmText('AKIA1234567890ABCDEF').text).toContain(
      '[REDACTED_SECRET]',
    );
    expect(
      sanitizeOutboundLlmText('sk-ant-abcdeabcdeabcdeabcdeabcde').text,
    ).toContain('[REDACTED_SECRET]');
    expect(sanitizeOutboundLlmText(jwt).text).toContain('[REDACTED_SECRET]');
  });

  it('blocks a bare high-entropy token that sits next to secret context', () => {
    const sanitized = sanitizeOutboundLlmText(
      'token= A9xQ7mN2pR5sT8uV1wX4yZ6aB3cD5eF7gH9iJ0kL2',
    );
    expect(sanitized.blocked).toBe(true);
  });
});
