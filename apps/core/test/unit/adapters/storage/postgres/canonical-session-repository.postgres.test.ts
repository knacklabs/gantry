import { describe, expect, it } from 'vitest';

import { buildCurrentScopeResetMatcher } from '@core/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';

describe('buildCurrentScopeResetMatcher', () => {
  it('includes descendant patterns for bare group scope resets', () => {
    const matcher = buildCurrentScopeResetMatcher('main');

    expect(matcher).toEqual({
      currentScopeExact: 'main',
      currentScopeDescendantLike: 'main::%',
    });
  });

  it('keeps scoped conversation/thread resets exact (no descendant wildcard)', () => {
    const matcher = buildCurrentScopeResetMatcher(
      'main::conversation:sl%3AC-A::thread:111.222',
    );

    expect(matcher).toEqual({
      currentScopeExact: 'main::conversation:sl%3AC-A::thread:111.222',
    });
  });

  it('keeps scoped dm resets exact (no descendant wildcard)', () => {
    const matcher = buildCurrentScopeResetMatcher(
      'main::conversation:sl%3AD-1::user:U123',
    );

    expect(matcher).toEqual({
      currentScopeExact: 'main::conversation:sl%3AD-1::user:U123',
    });
  });
});
