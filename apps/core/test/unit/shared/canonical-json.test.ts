import { describe, expect, it } from 'vitest';

import { canonicalJson } from '@core/shared/canonical-json.js';

describe('canonicalJson', () => {
  it('includes special JSON field names in signed bytes', () => {
    const payload = JSON.parse(
      '{"workerId":"worker-1","__proto__":{"role":"attacker"}}',
    ) as unknown;

    expect(canonicalJson(payload)).toBe(
      '{"__proto__":{"role":"attacker"},"workerId":"worker-1"}',
    );
  });
});
