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

/** Stored rows, answering the bot lookup the way the repository does. */
function storedRows(rows: NewMessage[]) {
  return {
    hasSentBotMessage: vi.fn(
      async (
        _chatJid: string,
        where: { threadId?: string; externalMessageId?: string },
      ) =>
        rows.some(
          (row) =>
            row.is_from_me &&
            (!where.threadId ||
              row.thread_id === where.threadId ||
              row.external_message_id === where.threadId) &&
            (!where.externalMessageId ||
              row.external_message_id === where.externalMessageId),
        ),
    ),
  };
}

function decide(
  messages: NewMessage[],
  stored: NewMessage[] = [],
  scope: { chatJid?: string; threadId?: string | null } = {},
  receivedDuringTurn: NewMessage[] = [],
) {
  return decideBatch({
    group,
    chatJid: scope.chatJid ?? 'tg:-100',
    threadId: scope.threadId ?? null,
    triggerPattern: /^@Andy\b/i,
    messages,
    receivedDuringTurn: new Set(receivedDuringTurn),
    messageRepository: storedRows(stored),
  });
}

describe('decideBatch', () => {
  it.each([
    ['Document', 'file'],
    ['Photo', 'image'],
    ['Video', 'video'],
    ['Voice message', 'audio'],
    ['Audio', 'audio'],
    ['Sticker', 'other'],
    ['Animation', 'other'],
  ] as const)(
    'matches %s captions without treating filename brackets as the prefix end',
    async (label, kind) => {
      for (const fileName of [
        'report[1].pdf',
        'report[[1]] draft.pdf',
        'report] @Andy [draft.pdf',
      ]) {
        for (const reference of ['', ' (ref)']) {
          const media = (caption: string) =>
            message({
              content: `[${label}: ${fileName}]${reference} ${caption}`,
              attachments: [{ id: 'media', kind, file_name: fileName }],
            });
          await expect(decide([media('@Andy review [this]')])).resolves.toBe(
            true,
          );
          await expect(
            decide([media('Please review @Andy [this]')]),
          ).resolves.toBe(false);
        }
      }
    },
  );

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

  it('takes a message sent while an earlier turn was running', async () => {
    const followUp = message({
      id: 'mid-turn',
      content: 'oh and use metric units',
    });
    await expect(decide([followUp], [], {}, [followUp])).resolves.toBe(true);
  });

  it('keeps an unrelated group message as history, even when a job posts after it', async () => {
    const unrelated = message({
      id: 'unrelated',
      content: 'lunch anyone?',
      timestamp: '2026-10-01T12:00:00.000Z',
    });
    await expect(
      decide(
        [unrelated],
        [unrelated, { ...botReply, timestamp: '2026-10-01T12:00:05.000Z' }],
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
    await expect(
      decide([blockedMention], [], {}, [blockedMention]),
    ).resolves.toBe(false);
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
