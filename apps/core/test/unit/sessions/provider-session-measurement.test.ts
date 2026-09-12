import { describe, expect, it } from 'vitest';

import {
  normalizeProviderSessionContextHighWaterMark,
  ProviderSessionMeasurementError,
} from '@core/domain/sessions/provider-session-measurement.js';

describe('provider session measurement', () => {
  it('clamps a mark above the column integer maximum to 2147483647', () => {
    expect(normalizeProviderSessionContextHighWaterMark(2_147_483_648)).toBe(
      2_147_483_647,
    );
  });

  it('stores 2147483647 unchanged at the clamp boundary', () => {
    expect(normalizeProviderSessionContextHighWaterMark(2_147_483_647)).toBe(
      2_147_483_647,
    );
  });

  it('still rejects a negative or non-integer mark', () => {
    expect(() => normalizeProviderSessionContextHighWaterMark(-1)).toThrow(
      ProviderSessionMeasurementError,
    );
    expect(() => normalizeProviderSessionContextHighWaterMark(1.5)).toThrow(
      ProviderSessionMeasurementError,
    );
  });
});
