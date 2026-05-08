import { describe, expect, it } from 'vitest';

import {
  sanitizeRetryTailForCanonicalDestination,
  sanitizeRetryTailProviderPayloadDestinationMetadata,
} from '@core/app/bootstrap/runtime-services-destination-hints.js';

describe('runtime-services destination hint metadata sanitization', () => {
  it('drops mismatched Slack channelId metadata and preserves matching ids', () => {
    const mismatched = sanitizeRetryTailProviderPayloadDestinationMetadata(
      {
        provider: 'slack',
        channelId: 'CWRONG',
        threadId: 'thread-1',
      },
      'sl:C123',
    );
    expect(mismatched).toEqual({
      provider: 'slack',
      threadId: 'thread-1',
    });

    const matching = sanitizeRetryTailProviderPayloadDestinationMetadata(
      {
        provider: 'slack',
        channelId: 'sl:C123',
      },
      'sl:C123',
    );
    expect(matching).toEqual({
      provider: 'slack',
      channelId: 'C123',
    });
  });

  it('drops mismatched Telegram chatId metadata from retry tails', () => {
    const sanitized = sanitizeRetryTailForCanonicalDestination(
      {
        canonicalText: 'unsent tail',
        providerPayload: {
          provider: 'telegram',
          chatId: 'tg:-100999',
          threadId: '42',
        },
      },
      'tg:-100123',
    );
    expect(sanitized).toEqual({
      canonicalText: 'unsent tail',
      providerPayload: {
        provider: 'telegram',
        threadId: '42',
      },
    });
  });
});
