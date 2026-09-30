import { expect, it, vi } from 'vitest';

vi.mock('@core/config/index.js', () => ({
  ASSISTANT_NAME: 'Andy',
  PERMISSION_APPROVAL_TIMEOUT_MS: 300000,
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sent = vi.hoisted(() => vi.fn(async () => ({ message_id: 1 })));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      sendMessage: sent,
      config: { use: vi.fn() },
      setMyCommands: vi.fn(async () => true),
    };
    command() {}
    on() {}
    stop() {}
  },
}));

import { TelegramChannel } from '@core/channels/telegram/channel-adapter.js';

it('does not stream to direct Telegram chats', async () => {
  const channel = new TelegramChannel('test-token', {
    onMessage: vi.fn(),
  });
  await channel.connect({ inbound: false });

  expect(await channel.sendStreamingChunk('tg:123', 'Hello')).toBe(false);
  expect(sent).not.toHaveBeenCalled();
});
