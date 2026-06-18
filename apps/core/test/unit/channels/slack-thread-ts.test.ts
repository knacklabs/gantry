import { describe, expect, it } from 'vitest';

import { slackThreadTsFromThreadId } from '@core/channels/slack/thread-ts.js';

describe('slackThreadTsFromThreadId', () => {
  it('passes through raw Slack thread timestamps', () => {
    expect(slackThreadTsFromThreadId('1711111111.000200')).toBe(
      '1711111111.000200',
    );
  });

  it('extracts raw timestamps from canonical Slack thread ids', () => {
    expect(
      slackThreadTsFromThreadId('thread:sl:C1234567890:1711111111.000200'),
    ).toBe('1711111111.000200');
    expect(
      slackThreadTsFromThreadId('thread:slack:C1234567890:1711111111.000200'),
    ).toBe('1711111111.000200');
  });

  it('omits empty or invalid values instead of sending malformed Slack payloads', () => {
    expect(slackThreadTsFromThreadId('')).toBeUndefined();
    expect(
      slackThreadTsFromThreadId('thread:sl:C1234567890:not-a-ts'),
    ).toBeUndefined();
    expect(
      slackThreadTsFromThreadId('thread:tg:123:1711111111.000200'),
    ).toBeUndefined();
  });
});
