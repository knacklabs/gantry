import { describe, expect, it, vi } from 'vitest';

const controlRepo = {
  getAppSessionByChatJid: vi.fn(),
  getAppResponseRoute: vi.fn(),
  addControlEvent: vi.fn(),
};

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => controlRepo,
}));

import { createAppChannel } from '@core/channels/app.js';

describe('app channel', () => {
  it('uses per-message response routing for outbound replies', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getAppResponseRoute.mockResolvedValue({
      sessionId: 'session-1',
      threadId: 'thread-1',
      responseMode: 'webhook',
      webhookId: 'webhook-1',
      correlationId: 'corr-1',
    });
    controlRepo.addControlEvent.mockResolvedValue({ eventId: 1 });
    const channel = await createAppChannel({} as never);

    await channel.sendMessage('app:demo:conversation', 'done', {
      threadId: 'thread-1',
    });

    expect(controlRepo.getAppResponseRoute).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-1',
    });
    expect(controlRepo.addControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'session.message.outbound',
        responseMode: 'webhook',
        webhookId: 'webhook-1',
        correlationId: 'corr-1',
      }),
    );
  });
});
