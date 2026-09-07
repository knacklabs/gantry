import { describe, expect, it } from 'vitest';

import {
  decodePermissionDecisionCode,
  encodePermissionRememberCode,
  PERMISSION_REMEMBER_CODES,
} from '@core/application/permissions/permission-remember-codec.js';

describe('permission remember codec', () => {
  it('round-trips the four remember codes and the three scalar modes and returns null for anything else', () => {
    for (const code of PERMISSION_REMEMBER_CODES) {
      const decoded = decodePermissionDecisionCode(code);
      expect(decoded?.remember).toBeDefined();
      expect(encodePermissionRememberCode(decoded!.remember!)).toBe(code);
    }

    for (const mode of [
      'allow_once',
      'allow_persistent_rule',
      'cancel',
    ] as const) {
      expect(decodePermissionDecisionCode(mode)).toEqual({ mode });
    }
    expect(decodePermissionDecisionCode('unknown')).toBeNull();
  });
});
