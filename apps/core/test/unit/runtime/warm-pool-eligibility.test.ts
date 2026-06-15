import { describe, expect, it } from 'vitest';

import { isPoolEligible } from '@core/runtime/warm-pool-eligibility.js';

describe('warm-pool eligibility', () => {
  it('allows genuinely new conversations with no saved provider session', () => {
    expect(isPoolEligible({})).toBe(true);
    expect(isPoolEligible({ sessionId: undefined })).toBe(true);
    expect(isPoolEligible({ sessionId: '' })).toBe(true);
    expect(isPoolEligible({ sessionId: '   ' })).toBe(true);
  });

  it('rejects returning conversations with a saved spawn session id', () => {
    expect(isPoolEligible({ sessionId: 'claude-session-1' })).toBe(false);
  });

  it('rejects returning conversations when called with the source external session id', () => {
    expect(isPoolEligible({ externalSessionId: 'claude-session-1' })).toBe(
      false,
    );
  });
});
