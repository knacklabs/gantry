import { afterEach, describe, expect, it } from 'vitest';

import {
  isTestOperatorJid,
  jidInTestScope,
  testOperatorPhone,
} from '@core/shared/test-mode.js';

describe('test-mode scoping', () => {
  afterEach(() => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
  });

  it('is unscoped (applies to all) when no operator is configured', () => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
    expect(testOperatorPhone()).toBeUndefined();
    expect(jidInTestScope('wa:919654405340')).toBe(true);
    expect(jidInTestScope('wa:919999999999')).toBe(true);
  });

  it('matches only the operator conversation when configured', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340';
    expect(jidInTestScope('wa:919654405340')).toBe(true);
    expect(jidInTestScope('wa:919999999999')).toBe(false);
    expect(jidInTestScope('tg:919654405340')).toBe(true);
  });
});

describe('isTestOperatorJid (session-command allowance)', () => {
  afterEach(() => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
  });

  it('is strict: false for every jid when no operator is configured', () => {
    delete process.env.GANTRY_TEST_OPERATOR_PHONE;
    // Unlike jidInTestScope, this must NOT default to allow — it gates session
    // commands, so production (operator unset) must be a hard no-op.
    expect(isTestOperatorJid('wa:919654405340')).toBe(false);
    expect(isTestOperatorJid('wa:919999999999')).toBe(false);
  });

  it('matches only the operator conversation (any channel prefix) when set', () => {
    process.env.GANTRY_TEST_OPERATOR_PHONE = '919654405340';
    expect(isTestOperatorJid('wa:919654405340')).toBe(true);
    expect(isTestOperatorJid('tg:919654405340')).toBe(true);
    expect(isTestOperatorJid('wa:918097288633')).toBe(false);
    expect(isTestOperatorJid('wa:919999999999')).toBe(false);
  });
});
