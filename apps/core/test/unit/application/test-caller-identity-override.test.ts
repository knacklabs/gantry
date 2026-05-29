import { afterEach, describe, expect, it } from 'vitest';

import { applyTestCallerIdentityOverride } from '@core/application/mcp/test-caller-identity-override.js';

describe('applyTestCallerIdentityOverride', () => {
  afterEach(() => {
    delete process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE;
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
  });

  it('is a no-op when the dev flag is unset', () => {
    delete process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE;
    expect(applyTestCallerIdentityOverride('wa:919654405340')).toBe(
      'wa:919654405340',
    );
  });

  it('swaps the numeric suffix and preserves the channel prefix (unscoped)', () => {
    process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE = '918097288633';
    expect(applyTestCallerIdentityOverride('wa:919654405340')).toBe(
      'wa:918097288633',
    );
  });

  it('leaves a JID without a numeric suffix unchanged', () => {
    process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE = '918097288633';
    expect(applyTestCallerIdentityOverride('app:default')).toBe('app:default');
  });

  it('only remaps the operator conversation when an operator is configured', () => {
    process.env.GANTRY_TEST_CALLER_IDENTITY_PHONE = '918097288633';
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340';
    // Operator's own conversation is remapped to the test customer.
    expect(applyTestCallerIdentityOverride('wa:919654405340')).toBe(
      'wa:918097288633',
    );
    // A real customer on a different number keeps their own identity.
    expect(applyTestCallerIdentityOverride('wa:919999999999')).toBe(
      'wa:919999999999',
    );
  });
});
