import { describe, expect, it, vi } from 'vitest';

import { routeSlackDeletion } from '@core/channels/slack/slack-message-deletion.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

const route = { folder: 'slack_ops', name: 'Ops' };

describe('routeSlackDeletion', () => {
  it('passes ordinary subtypes through without a durable callback', async () => {
    const callback = vi.fn(async () => undefined);

    await expect(
      routeSlackDeletion(
        {
          subtype: 'file_share',
          channel: 'C123',
          ts: 'event-ts',
        },
        {},
        ['slack-one'],
        callback,
      ),
    ).resolves.toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    { channel: 'C123' },
    { channel: 'C123', deleted_ts: '   ' },
    { channel: '   ', deleted_ts: 'deleted-ts' },
    { deleted_ts: 'deleted-ts' },
  ])(
    'claims an invalid deletion without a durable callback: %j',
    async (event) => {
      const callback = vi.fn(async () => undefined);

      await expect(
        routeSlackDeletion(
          { subtype: 'message_deleted', ts: 'event-ts', ...event },
          {},
          ['slack-one'],
          callback,
        ),
      ).resolves.toBe(true);
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'top-level',
      previous_message: { ts: 'deleted-ts' },
      channelId: 'sl:C123',
      routeKey: makeAgentThreadQueueKey('sl:C123', null, null, 'slack-two'),
    },
    {
      label: 'threaded',
      previous_message: {
        ts: 'deleted-ts',
        thread_ts: '  thread-parent-ts  ',
      },
      channelId: 'thread-parent-ts',
      routeKey: makeAgentThreadQueueKey(
        'sl:C123',
        null,
        'thread-parent-ts',
        'slack-two',
      ),
    },
  ])(
    'routes an admitted $label deletion using deleted_ts',
    async (testCase) => {
      const callback = vi.fn(async () => undefined);

      await expect(
        routeSlackDeletion(
          {
            subtype: 'message_deleted',
            channel: ' C123 ',
            ts: 'event-ts-must-not-be-used',
            deleted_ts: '  deleted-ts  ',
            previous_message: testCase.previous_message,
          },
          { [testCase.routeKey]: route },
          ['slack-one', 'slack-two'],
          callback,
        ),
      ).resolves.toBe(true);

      expect(callback).toHaveBeenCalledWith({
        providerId: 'slack',
        channelId: testCase.channelId,
        fallbackConversationJid: 'sl:C123',
        fallbackMatchesThreadedRows: true,
        externalMessageIds: ['deleted-ts'],
        deletedAt: expect.any(String),
      });
    },
  );

  it('defers unadmitted scope to the Slack-only stored threaded-row fallback', async () => {
    const callback = vi.fn(async () => undefined);

    await routeSlackDeletion(
      {
        subtype: 'message_deleted',
        channel: 'C123',
        ts: 'event-ts',
        deleted_ts: 'deleted-ts',
      },
      {},
      ['slack-one'],
      callback,
    );

    expect(callback).toHaveBeenCalledWith({
      providerId: 'slack',
      channelId: 'sl:C123',
      fallbackConversationJid: 'sl:C123',
      requireStoredMessageMatch: true,
      fallbackMatchesThreadedRows: true,
      externalMessageIds: ['deleted-ts'],
      deletedAt: expect.any(String),
    });
    expect(callback.mock.calls[0]?.[0]).not.toHaveProperty(
      'providerAccountIds',
    );
  });

  it('fails when a valid deletion has no callback and propagates callback rejection', async () => {
    const event = {
      subtype: 'message_deleted',
      channel: 'C123',
      deleted_ts: 'deleted-ts',
    };

    await expect(routeSlackDeletion(event, {}, ['slack-one'])).rejects.toThrow(
      'Slack message attachment deletion callback unavailable',
    );
    await expect(
      routeSlackDeletion(
        event,
        {},
        ['slack-one'],
        vi.fn(async () => {
          throw new Error('tombstone rejected');
        }),
      ),
    ).rejects.toThrow('tombstone rejected');
  });
});
