import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  formatRunLabel,
  formatRunShortId,
} from '@core/shared/human-format.js';

describe('human-format', () => {
  it.each([
    [0, '0s'],
    [100, '100ms'],
    [999, '999ms'],
    [15_000, '15s'],
    [60_000, '1 min'],
    [15 * 60_000, '15 min'],
    [132_000, '2m 12s'],
    [3 * 60 * 60_000 + 4 * 60_000, '3h 04m'],
  ])('formats %dms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('uses persisted short ids when available', () => {
    expect(
      formatRunShortId({ id: '550e8400-e29b-41d4-a716', short_id: 4 }),
    ).toBe('#4');
  });

  it('falls back to a stable redacted uuid prefix', () => {
    expect(formatRunShortId({ id: '550e8400-e29b-41d4-a716' })).toBe(
      'r-550e8400',
    );
  });

  it('formats labels with relative start and attempts', () => {
    expect(
      formatRunLabel({
        id: '550e8400-e29b-41d4-a716',
        shortId: 4,
        startedAt: '2026-05-13T12:00:00.000Z',
        nowMs: Date.parse('2026-05-13T12:02:00.000Z'),
        attempt: 1,
        attemptTotal: 3,
      }),
    ).toBe('Run #4 (started 2 min ago, attempt 1/3)');
  });
});
