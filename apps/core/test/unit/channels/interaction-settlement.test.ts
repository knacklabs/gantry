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
    vi.stubEnv('PERMISSION_APPROVAL_TIMEOUT_MS', '120000');

    expect(
      resolveInteractionSettlementDelayMs({
        expiresAt: '2026-07-25T00:01:00.000Z',
        permissionLane: 'autonomous',
        fallbackTimeoutMs: 180000,
      }),
    ).toBe(60000);
  });

  it('keeps a job permission pending when expiry is absent or invalid', () => {
    vi.stubEnv('PERMISSION_APPROVAL_TIMEOUT_MS', '120000');

    expect(
      resolveInteractionSettlementDelayMs({
        expiresAt: 'not-a-date',
        isPermissionRequest: true,
        jobId: 'job-1',
        permissionLane: 'autonomous',
        fallbackTimeoutMs: 180000,
      }),
    ).toBeUndefined();
  });

  it('uses the lane timeout for a non-job permission request', () => {
    vi.stubEnv('PERMISSION_APPROVAL_TIMEOUT_MS', '120000');

    expect(
      resolveInteractionSettlementDelayMs({
        isPermissionRequest: true,
        permissionLane: 'autonomous',
        fallbackTimeoutMs: 180000,
      }),
    ).toBe(120000);
  });

  it('treats a permission lane sentinel as no timer even when a fallback is finite', () => {
    vi.stubEnv(
      'GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS',
      String(NO_PERMISSION_TIMEOUT_MS),
    );

    expect(
      resolveInteractionSettlementDelayMs({
        isPermissionRequest: true,
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

  it('uses a question lane timer even when it carries job metadata', () => {
    vi.stubEnv('PERMISSION_APPROVAL_TIMEOUT_MS', '120000');

    expect(
      resolveInteractionSettlementDelayMs({
        jobId: 'job-1',
        permissionLane: 'autonomous',
        fallbackTimeoutMs: 180000,
      }),
    ).toBe(120000);
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
