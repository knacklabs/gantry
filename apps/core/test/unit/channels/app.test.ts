import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

const controlRepo = {
  getAppSessionByChatJid: vi.fn(),
  getAppResponseRoute: vi.fn(),
};
const runtimeEvents = {
  publish: vi.fn(),
};

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => controlRepo,
  getRuntimeEventExchange: () => runtimeEvents,
}));

import { createAppChannel } from '@core/channels/app.js';

describe('app channel', () => {
  it('uses per-message response routing for outbound replies', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-1',
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
    runtimeEvents.publish.mockResolvedValue({ eventId: 1 });
    const channel = await createAppChannel({} as never);

    await channel.sendMessage('app:demo:conversation', 'done', {
      threadId: 'thread-1',
    });

    expect(controlRepo.getAppResponseRoute).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-1',
    });
    expect(runtimeEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        responseMode: 'webhook',
        webhookId: 'webhook-1',
        correlationId: 'corr-1',
      }),
    );
  });
});
