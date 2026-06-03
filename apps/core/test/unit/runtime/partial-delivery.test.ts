import { describe, expect, it } from 'vitest';
import {
  getPartialMessageDeliveryMetadata,
  isPartialMessageDeliveryError,
  PartialMessageDeliveryError,
} from '@core/domain/messages/partial-delivery.js';

describe('partial delivery errors', () => {
  it('recognizes branded partial delivery errors with visible chunks', () => {
    const cause = Object.assign(new Error('provider token leaked'), {
      token: 'SECRET_TOKEN',
    });
    const err = new PartialMessageDeliveryError({
      cause,
      deliveredChunks: 1,
      message: 'message partially delivered',
      name: 'PartialTelegramDeliveryError',
      totalChunks: 2,
    });

    expect(isPartialMessageDeliveryError(err)).toBe(true);
  });

  it('rejects structurally forged partial delivery flags', () => {
    const err = Object.assign(new Error('forged partial delivery'), {
      partialMessageDelivery: true,
      deliveredChunks: 1,
      totalChunks: 2,
    });

    expect(isPartialMessageDeliveryError(err)).toBe(false);
  });

  it('rejects branded partial delivery errors without delivered chunks', () => {
    const err = new PartialMessageDeliveryError({
      cause: new Error('provider failure before visible output'),
      deliveredChunks: 0,
      message: 'no chunks delivered',
      name: 'PartialTelegramDeliveryError',
      totalChunks: 2,
    });

    expect(isPartialMessageDeliveryError(err)).toBe(false);
  });

  it('extracts provider partial metadata for retry-tail persistence', () => {
    const err = new PartialMessageDeliveryError({
      cause: new Error('provider failed after partial append'),
      deliveredChunks: 1,
      message: 'partial native append',
      name: 'PartialSlackNativeStreamAppendDeliveryError',
      totalChunks: 2,
    });
    Object.assign(err, {
      provider: 'slack',
      deliveredParts: 1,
      totalParts: 4,
      retryTail: {
        canonicalText: 'remaining suffix',
        providerPayload: { provider: 'slack' },
      },
      sentPrefix: 'prefix',
      externalMessageIds: ['1710000000.200300'],
    });

    expect(getPartialMessageDeliveryMetadata(err)).toEqual({
      deliveredParts: 1,
      totalParts: 4,
      provider: 'slack',
      retryTail: {
        canonicalText: 'remaining suffix',
        providerPayload: { provider: 'slack' },
      },
      sentPrefix: 'prefix',
      externalMessageIds: ['1710000000.200300'],
    });
  });

  it('drops unknown, text-like, and secret-looking retry-tail payload fields', () => {
    const err = new PartialMessageDeliveryError({
      cause: new Error('provider failed after partial append'),
      deliveredChunks: 1,
      message: 'partial native append',
      name: 'PartialSlackNativeStreamAppendDeliveryError',
      totalChunks: 2,
    });
    Object.assign(err, {
      retryTail: {
        canonicalText: 'remaining suffix',
        providerPayload: {
          provider: 'slack',
          channelId: 'C123',
          text: 'should not persist',
          fullText: 'should not persist',
          apiToken: 'SECRET_VALUE',
          unknownField: 'drop-me',
          warnings: ['slack.partial_delivery', '   ', 'x'.repeat(200)],
        },
      },
    });

    expect(getPartialMessageDeliveryMetadata(err)).toEqual({
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'remaining suffix',
        providerPayload: {
          provider: 'slack',
          channelId: 'C123',
          warnings: ['slack.partial_delivery'],
        },
      },
    });
  });

  it('drops retry-tail warning entries that are not safe warning codes', () => {
    const err = new PartialMessageDeliveryError({
      cause: new Error('provider failed after partial append'),
      deliveredChunks: 1,
      message: 'partial native append',
      name: 'PartialSlackNativeStreamAppendDeliveryError',
      totalChunks: 2,
    });
    Object.assign(err, {
      retryTail: {
        canonicalText: 'remaining suffix',
        providerPayload: {
          provider: 'slack',
          channelId: 'C123',
          warnings: [
            'slack.partial_delivery',
            'Authorization: Bearer xoxb-123456',
            'token=sk-live-abcdef',
            'human readable warning text',
            'SLACK.RATE_LIMIT_RETRY',
          ],
        },
      },
    });

    expect(getPartialMessageDeliveryMetadata(err)).toEqual({
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'remaining suffix',
        providerPayload: {
          provider: 'slack',
          channelId: 'C123',
          warnings: ['slack.partial_delivery'],
        },
      },
    });
  });
});
