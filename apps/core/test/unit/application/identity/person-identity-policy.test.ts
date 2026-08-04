import { describe, expect, it } from 'vitest';

import { assertMergeablePeople } from '@core/application/identity/person-identity-policy.js';

describe('person identity policy', () => {
  it('refuses to merge people of different kinds', () => {
    expect(() =>
      assertMergeablePeople(
        [
          { status: 'active', kind: 'human' },
          { status: 'active', kind: 'service' },
        ],
        'person-human',
        'person-service',
      ),
    ).toThrow('People of different kinds cannot be merged.');
  });
});
