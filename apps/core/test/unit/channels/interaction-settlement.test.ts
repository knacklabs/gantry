import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveInteractionSettlementDelayMs } from '@core/channels/interaction-settlement.js';
import { NO_PERMISSION_TIMEOUT_MS } from '@core/shared/permission-timeout.js';

describe('interaction settlement delay', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('prefers a parseable absolute expiry and recomputes from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00.000Z'));
    vi.stubEnv('GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS', '120000');

    expect(
      resolveInteractionSettlementDelayMs({
        expiresAt: '2026-07-25T00:01:00.000Z',
        permissionLane: 'autonomous',
        fallbackTimeoutMs: 180000,
      }),
    ).toBe(60000);
  });

  it('uses a finite lane timeout when the expiry is absent or invalid', () => {
    vi.stubEnv('GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS', '120000');

    expect(
      resolveInteractionSettlementDelayMs({
        expiresAt: 'not-a-date',
        permissionLane: 'autonomous',
        fallbackTimeoutMs: 180000,
      }),
    ).toBe(120000);
  });

  it('treats a lane sentinel as no timer even when a fallback is finite', () => {
    vi.stubEnv(
      'GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS',
      String(NO_PERMISSION_TIMEOUT_MS),
    );

    expect(
      resolveInteractionSettlementDelayMs({
        permissionLane: 'interactive',
        fallbackTimeoutMs: 180000,
      }),
    ).toBeUndefined();
  });

  it('uses a finite fallback for a lane-less request', () => {
    expect(
      resolveInteractionSettlementDelayMs({
        fallbackTimeoutMs: 180000,
      }),
    ).toBe(180000);
  });

  it('schedules no timer without an absolute, lane, or finite fallback', () => {
    expect(
      resolveInteractionSettlementDelayMs({
        expiresAt: 'not-a-date',
        fallbackTimeoutMs: NO_PERMISSION_TIMEOUT_MS,
      }),
    ).toBeUndefined();
  });
});
