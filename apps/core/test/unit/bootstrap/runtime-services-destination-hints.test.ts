import { describe, expect, it } from 'vitest';

import {
  normalizeDestinationHintAgainstCanonical,
  sanitizeRetryTailForCanonicalDestination,
  sanitizeRetryTailProviderPayloadDestinationMetadata,
} from '@core/app/bootstrap/runtime-services-destination-hints.js';

describe('runtime-services destination hint metadata sanitization', () => {
  it('accepts account-scoped canonical conversation hints for the resolved provider jid', () => {
    expect(
      normalizeDestinationHintAgainstCanonical(
        'conversation:slack_account:sl:C123',
        'sl:C123',
      ),
    ).toEqual({
      providerJid: 'sl:C123',
      malformedCanonicalHint: false,
    });
  });

  it('accepts account-scoped canonical hints when the provider account id has colons', () => {
    expect(
      normalizeDestinationHintAgainstCanonical(
        'conversation:channel-providerAccount:app-one:slack:sl:C123',
        'sl:C123',
      ),
    ).toEqual({
      providerJid: 'sl:C123',
      malformedCanonicalHint: false,
    });
  });

  it('accepts account-scoped canonical hints for providers outside Slack and Telegram', () => {
    expect(
      normalizeDestinationHintAgainstCanonical(
        'conversation:teams_default:teams:19:thread@thread.v2',
        'teams:19:thread@thread.v2',
      ),
    ).toEqual({
      providerJid: 'teams:19:thread@thread.v2',
      malformedCanonicalHint: false,
    });

    expect(
      normalizeDestinationHintAgainstCanonical(
        'conversation:discord_default:dc:123',
        'dc:123',
      ),
    ).toEqual({
      providerJid: 'dc:123',
      malformedCanonicalHint: false,
    });
  });

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
