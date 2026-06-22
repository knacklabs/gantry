import { describe, expect, it, vi } from 'vitest';

import { createChannelMessageActionRouter } from '@core/app/bootstrap/channel-message-action-router.js';

describe('createChannelMessageActionRouter', () => {
  it('routes live stop callbacks to the registered handler', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn();
    router.set(handler);
    const actionToken = '67ad9359-9a43-4fb7-a782-c21a5ef9442a';
    expect(`lt:stop:${actionToken}`.length).toBeLessThanOrEqual(64);

    await router.handle({
      kind: 'live_turn_stop',
      conversationJid: 'tg:chat',
      threadId: 'topic',
      actionToken,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed live stop callback tokens', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn();
    router.set(handler);

    await router.handle({
      kind: 'live_turn_stop',
      conversationJid: 'sl:C123',
      actionToken: 'token-1',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores callbacks when no handler is registered', async () => {
    const router = createChannelMessageActionRouter();
    const handler = vi.fn();
    await router.handle({
      kind: 'live_turn_stop',
      conversationJid: 'sl:C123',
      actionToken: 'token-1',
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
