import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  recoverSlackIngress,
  slackRetryAfterMs,
} from '@core/channels/slack/reconnect-replay.js';
import type { ConversationIngressRecovery } from '@core/domain/ports/conversation-ingress-cursor.js';

function fixture() {
  const target = {
    agentId: 'agent:atlas',
    providerAccountId: 'provider-account:slack',
    conversationId: 'conversation:slack:C123',
    externalConversationId: 'C123',
    installedAt: '2026-09-20T00:00:00.000Z',
  };
  let version = 0;
  const recovery: ConversationIngressRecovery = {
    listTargets: vi.fn(async () => [target]),
    getCursor: vi.fn(async () => null),
    advanceCursor: vi.fn(async (input) => {
      expect(input.expectedVersion).toBe(version);
      version += 1;
      return 'advanced';
    }),
    publish: vi.fn(async () => undefined),
  };
  const app = {
    client: {
      conversations: {
        history: vi.fn(),
        replies: vi.fn(),
      },
    },
  };
  return { app, recovery, target };
}

afterEach(() => vi.useRealTimers());

describe('Slack reconnect replay', () => {
  it('replays channel and thread messages chronologically through the shared ingress path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
    const { app, recovery } = fixture();
    app.client.conversations.history.mockResolvedValue({
      messages: [
        {
          channel: 'C123',
          ts: '1789891203.000000',
          text: '@bot third',
          user: 'U1',
        },
        {
          channel: 'C123',
          ts: '1789891201.000000',
          text: '@bot parent',
          user: 'U1',
          reply_count: 1,
          latest_reply: '1789891202.000000',
        },
      ],
      response_metadata: { next_cursor: '' },
    });
    app.client.conversations.replies.mockResolvedValue({
      messages: [
        {
          channel: 'C123',
          ts: '1789891201.000000',
          text: '@bot parent',
          user: 'U1',
        },
        {
          channel: 'C123',
          ts: '1789891202.000000',
          thread_ts: '1789891201.000000',
          text: '@bot second',
          user: 'U1',
        },
      ],
      response_metadata: { next_cursor: '' },
    });
    const ingest = vi.fn(async () => undefined);

    await recoverSlackIngress({
      app: app as never,
      providerAccountId: 'provider-account:slack',
      recovery,
      ingest,
    });

    expect(ingest.mock.calls.map(([message]) => message.ts)).toEqual([
      '1789891201.000000',
      '1789891202.000000',
      '1789891203.000000',
    ]);
    expect(recovery.advanceCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        coveredThroughTimestamp: '2026-09-20T12:00:00.000Z',
      }),
    );
    expect(recovery.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'channel.replay.completed' }),
    );
  });

  it('uses the later install or 24-hour floor and stops when cursor CAS is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
    const { app, recovery } = fixture();
    vi.mocked(recovery.getCursor).mockResolvedValue({
      coveredThroughTimestamp: '2026-09-18T00:00:00.000Z',
      version: 4,
    });
    vi.mocked(recovery.advanceCursor).mockResolvedValue('stale');
    app.client.conversations.history.mockResolvedValue({
      messages: [
        {
          ts: '1789891201.000000',
          text: '@bot hello',
          user: 'U1',
        },
      ],
    });
    const ingest = vi.fn(async () => undefined);

    await recoverSlackIngress({
      app: app as never,
      providerAccountId: 'provider-account:slack',
      recovery,
      ingest,
    });

    expect(app.client.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ oldest: '1789862400.000000' }),
    );
    expect(recovery.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 4 }),
    );
    expect(recovery.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'channel.replay.completed' }),
    );
  });

  it('advances in batches of at most 500 and respects Slack retry-after values', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
    const { app, recovery } = fixture();
    const firstTs = 1789862401;
    app.client.conversations.history.mockResolvedValue({
      messages: Array.from({ length: 501 }, (_, index) => ({
        ts: `${firstTs + index}.000000`,
        text: '@bot hello',
        user: 'U1',
      })),
    });

    await recoverSlackIngress({
      app: app as never,
      providerAccountId: 'provider-account:slack',
      recovery,
      ingest: vi.fn(async () => undefined),
    });

    expect(recovery.advanceCursor).toHaveBeenCalledTimes(3);
    expect(slackRetryAfterMs({ data: { retry_after: 12 } })).toBe(12_000);
  });
});
