import { describe, expect, it, vi } from 'vitest';

import type { NewMessage } from '@core/domain/types.js';
import { decideBatch } from '@core/runtime/group-trigger-policy.js';

vi.mock('@core/platform/sender-allowlist.js', () => ({
  loadSenderAllowlist: () => ({}),
  isTriggerAllowed: (_chatJid: string, sender: string) => sender !== 'blocked',
}));

const group = {
  folder: 'team',
  requiresTrigger: true,
  providerAccountId: 'account',
};

function message(overrides: Partial<NewMessage>): NewMessage {
  return {
    id: overrides.id ?? 'm1',
    chat_jid: 'tg:-100',
    sender: 'alice',
    sender_name: 'Alice',
    content: 'plain text',
    timestamp: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

const botReply = message({
  id: 'bot-reply',
  sender: 'gantry',
  content: 'Here is the plan.',
  is_from_me: true,
  external_message_id: 'bot-77',
});

type ReadOptions = {
  threadId?: string | null;
  externalMessageId?: string;
  providerAccountId?: string | null;
};

/** Stored rows in both directions, filtered the way the context read does. */
function storedRows(rows: NewMessage[]) {
  return {
    getContextMessagesSince: vi.fn(
      async (
        _chatJid: string,
        since: string,
        _limit?: number,
        options: ReadOptions = {},
      ) =>
        rows.filter(
          (row) =>
            (!options.externalMessageId ||
              row.external_message_id === options.externalMessageId) &&
            (!('threadId' in options) ||
              (row.thread_id ?? null) === options.threadId) &&
            (!since || Date.parse(row.timestamp) > Date.parse(since)),
        ),
    ),
  };
}

function decide(
  messages: NewMessage[],
  stored: NewMessage[] = [],
  scope: { chatJid?: string; threadId?: string | null } = {},
) {
  return decideBatch({
    group,
    chatJid: scope.chatJid ?? 'tg:-100',
    threadId: scope.threadId ?? null,
    triggerPattern: /^@Andy\b/i,
    messages,
    messageRepository: storedRows(stored),
    pageSize: 50,
  });
}

describe('decideBatch', () => {
  it('takes every part of a split message when one part mentions the bot', async () => {
    await expect(
      decide([
        message({
          id: 'part-1',
          content: 'hey @team_bot here is the first half',
          mentionsBot: true,
        }),
        message({ id: 'part-2', content: 'and the second half of it' }),
      ]),
    ).resolves.toBe(true);
  });

  it('takes a reply to the bot and keeps a reply to a person as history', async () => {
    const humanMessage = message({
      id: 'human',
      external_message_id: 'human-5',
    });
    const stored = [botReply, humanMessage];

    await expect(
      decide([message({ id: 'reply', reply_to_message_id: 'bot-77' })], stored),
    ).resolves.toBe(true);
    await expect(
      decide(
        [message({ id: 'reply', reply_to_message_id: 'human-5' })],
        stored,
      ),
    ).resolves.toBe(false);
  });

  it.each([
    ['a Slack thread', 'sl:C123', '1710000000.000100'],
    ['a Telegram topic', 'tg:-100', '42'],
    ['a Discord thread', 'dc:900', '901'],
  ])(
    'takes a follow-up in %s where the bot already replied',
    async (_place, chatJid, threadId) => {
      const followUp = message({
        id: 'follow-up',
        chat_jid: chatJid,
        thread_id: threadId,
        content: 'also check the budget',
        timestamp: '2026-10-01T11:00:00.000Z',
      });
      await expect(
        decide(
          [followUp],
          [{ ...botReply, chat_jid: chatJid, thread_id: threadId }, followUp],
          { chatJid, threadId },
        ),
      ).resolves.toBe(true);
      await expect(
        decide(
          [followUp],
          [message({ id: 'human-root', thread_id: threadId }), followUp],
          { chatJid, threadId },
        ),
      ).resolves.toBe(false);
    },
  );

  it('takes a message sent while the bot was still answering', async () => {
    const followUp = message({
      id: 'mid-turn',
      content: 'oh and use metric units',
      timestamp: '2026-10-01T10:00:00.000Z',
    });
    await expect(
      decide(
        [followUp],
        [followUp, { ...botReply, timestamp: '2026-10-01T10:00:03.000Z' }],
      ),
    ).resolves.toBe(true);
  });

  it('keeps an unrelated group message as history', async () => {
    const unrelated = message({
      id: 'unrelated',
      content: 'lunch anyone?',
      timestamp: '2026-10-01T12:00:00.000Z',
    });
    await expect(
      decide(
        [unrelated],
        [{ ...botReply, timestamp: '2026-10-01T09:00:00.000Z' }, unrelated],
      ),
    ).resolves.toBe(false);
  });

  it('needs an allowed sender for a mention or a continuation', async () => {
    const threadId = '42';
    const stored = [{ ...botReply, thread_id: threadId }];
    const blockedMention = message({
      id: 'blocked-mention',
      sender: 'blocked',
      content: '@Andy do this',
      mentionsBot: true,
    });
    const blockedFollowUp = message({
      id: 'blocked-follow-up',
      sender: 'blocked',
      thread_id: threadId,
    });

    await expect(decide([blockedMention], stored)).resolves.toBe(false);
    await expect(decide([blockedFollowUp], stored, { threadId })).resolves.toBe(
      false,
    );
    await expect(
      decide(
        [blockedFollowUp, message({ id: 'allowed', thread_id: threadId })],
        stored,
        { threadId },
      ),
    ).resolves.toBe(true);
  });
});
