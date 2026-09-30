import { describe, expect, it, vi } from 'vitest';

import {
  handleFailure,
  takeGroupTurnInput,
} from '@core/runtime/group-processing-flow.js';

it('presents a taken batch by provider second and receive order', async () => {
  const messages = [
    {
      id: 'first',
      chat_jid: 'tg:batch',
      sender: 'person',
      content: 'first',
      timestamp: '2026-09-29T10:00:02.000Z',
      is_from_me: false,
      is_bot_message: false,
    },
    {
      id: 'second',
      chat_jid: 'tg:batch',
      sender: 'person',
      content: 'second',
      timestamp: '2026-09-29T10:00:01.900Z',
      is_from_me: false,
      is_bot_message: false,
    },
    {
      id: 'third',
      chat_jid: 'tg:batch',
      sender: 'person',
      content: 'third',
      timestamp: '2026-09-29T10:00:01.100Z',
      is_from_me: false,
      is_bot_message: false,
    },
  ];
  const items = messages.map((message, index) => ({
    id: `item-${message.id}`,
    messageId: message.id,
    receiveOrder: index + 1,
  }));
  const takeInput = vi.fn(async () => {
    const item = items.shift();
    return item ? [item] : [];
  });
  const result = await takeGroupTurnInput({
    repository: { takeInput } as never,
    messages: {
      getMessagesByIds: vi.fn(async (_scope, ids: readonly string[]) =>
        messages.filter((message) => ids.includes(message.id)),
      ),
    } as never,
    scope: {
      appId: 'app',
      conversationId: 'tg:batch',
      threadId: null,
      agentId: null,
      providerAccountId: null,
    },
    consumer: 'turn:batch',
    maxMessages: 10,
    triggerPattern: /^!$/,
    chatJid: 'tg:batch',
  });

  expect(result.missedMessages.map((message) => message.id)).toEqual([
    'second',
    'third',
    'first',
  ]);
  expect(takeInput).toHaveBeenCalledTimes(4);
});

it('keeps the command that ended the take last in the presented batch', async () => {
  const messages = [
    {
      id: 'question',
      chat_jid: 'tg:batch',
      sender: 'person',
      content: 'question',
      timestamp: '2026-09-29T10:00:02.000Z',
      is_from_me: false,
      is_bot_message: false,
    },
    {
      id: 'command',
      chat_jid: 'tg:batch',
      sender: 'person',
      content: '/commands',
      timestamp: '2026-09-29T10:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    },
  ];
  const items = messages.map((message, index) => ({
    id: `item-${message.id}`,
    messageId: message.id,
    receiveOrder: index + 1,
  }));
  const result = await takeGroupTurnInput({
    repository: {
      takeInput: vi.fn(async () => {
        const item = items.shift();
        return item ? [item] : [];
      }),
    } as never,
    messages: {
      getMessagesByIds: vi.fn(async (_scope, ids: readonly string[]) =>
        messages.filter((message) => ids.includes(message.id)),
      ),
    } as never,
    scope: {
      appId: 'app',
      conversationId: 'tg:batch',
      threadId: null,
      agentId: null,
      providerAccountId: null,
    },
    consumer: 'turn:batch',
    maxMessages: 10,
    triggerPattern: /^!$/,
    chatJid: 'tg:batch',
  });

  expect(result.missedMessages.map((message) => message.id)).toEqual([
    'question',
    'command',
  ]);
  expect(result.hasMore).toBe(true);
});

function makeInput(
  overrides: Partial<Parameters<typeof handleFailure>[0]> = {},
) {
  return {
    outputSentToUser: false,
    groupName: 'Main Agent',
    queueJid: 'sl:C1234567890',
    releaseInput: vi.fn().mockResolvedValue(1),
    deps: {
      setCursor: vi.fn(),
      saveState: vi.fn(),
    },
    logger: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('handleFailure', () => {
  it('releases a failed turn before output so the next turn can take its input', async () => {
    const input = makeInput();

    await expect(handleFailure(input)).resolves.toBe(false);

    expect(input.releaseInput).toHaveBeenCalledOnce();
    expect(input.deps.setCursor).not.toHaveBeenCalled();
    expect(input.logger.warn).toHaveBeenCalledWith(
      { group: 'Main Agent' },
      'Agent error, released input for retry',
    );
  });

  it.each([{ outputSentToUser: true }, { failureNoticeDelivered: true }])(
    'keeps consumed input once the user saw output or the failure notice: %j',
    async (override) => {
      const input = makeInput(override);

      await expect(handleFailure(input)).resolves.toBe(true);

      expect(input.releaseInput).not.toHaveBeenCalled();
    },
  );
});
