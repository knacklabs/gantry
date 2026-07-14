import { describe, expect, it } from 'vitest';

import {
  parseControlApiKeys,
  parseControlApiKeysStrict,
} from '@core/shared/control-api-keys.js';

const validKey = {
  kid: 'limited-key',
  token: 'test-token',
  appId: 'app-one',
  scopes: ['llm:invoke'],
};

describe('control API key token limits', () => {
  it('parses an optional positive maxTokens limit', () => {
    const [key] = parseControlApiKeysStrict({
      rawJson: JSON.stringify([{ ...validKey, maxTokens: 4096 }]),
    });

    expect(key?.maxTokens).toBe(4096);
  });

  it('leaves keys without maxTokens unlimited', () => {
    const [key] = parseControlApiKeysStrict({
      rawJson: JSON.stringify([validKey]),
    });

    expect(key).not.toHaveProperty('maxTokens');
  });

  it.each([0, -1, 1.5, '4096'])(
    'rejects invalid maxTokens value %s',
    (maxTokens) => {
      const rawJson = JSON.stringify([{ ...validKey, maxTokens }]);

      expect(() => parseControlApiKeysStrict({ rawJson })).toThrow(
        '.maxTokens must be a positive integer',
      );
      expect(parseControlApiKeys({ rawJson })).toEqual([]);
    },
  );
});
