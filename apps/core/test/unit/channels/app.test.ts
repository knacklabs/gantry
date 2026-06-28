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
        payload: expect.objectContaining({
          text: 'done',
          threadId: 'thread-1',
          orderedEnvelope: expect.objectContaining({
            sequence: 1,
            kind: 'outbound',
            partIndex: 1,
            totalParts: 1,
          }),
          canonicalText: expect.objectContaining({
            lengthChars: 4,
            lengthBytes: 4,
            hasContent: true,
            hasTruncatedContent: false,
          }),
        }),
      }),
    );
    const firstPublish = runtimeEvents.publish.mock.calls[0]?.[0] as {
      payload: { canonicalText: { sha256: string } };
    };
    expect(firstPublish.payload.canonicalText.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps canonicalText metadata bounded for large payloads', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-1',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getAppResponseRoute.mockResolvedValue({
      sessionId: 'session-1',
      threadId: 'thread-2',
      responseMode: 'sse',
      webhookId: null,
      correlationId: 'corr-2',
    });
    runtimeEvents.publish.mockResolvedValue({ eventId: 2 });
    const channel = await createAppChannel({} as never);
    const largeText = 'L'.repeat(8_192);

    await channel.sendStreamingChunk('app:demo:conversation', largeText, {
      threadId: 'thread-2',
      done: false,
      generation: 7,
    });

    const publishInput = runtimeEvents.publish.mock.calls.at(-1)?.[0];
    expect(publishInput).toBeDefined();
    expect(publishInput).toEqual(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING,
        payload: expect.objectContaining({
          text: largeText,
          canonicalText: expect.objectContaining({
            lengthChars: largeText.length,
            lengthBytes: Buffer.byteLength(largeText, 'utf8'),
            hasContent: true,
            hasTruncatedContent: true,
          }),
        }),
      }),
    );
    const canonicalText = (
      publishInput as {
        payload: { canonicalText: Record<string, unknown> };
      }
    ).payload.canonicalText;
    expect(canonicalText).not.toHaveProperty('text');
    expect(canonicalText).not.toHaveProperty('preview');
    expect(canonicalText).not.toHaveProperty('previewTruncated');
    expect(canonicalText.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not copy secret-looking content into canonicalText metadata', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-1',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getAppResponseRoute.mockResolvedValue({
      sessionId: 'session-1',
      threadId: null,
      responseMode: 'sse',
      webhookId: null,
      correlationId: 'corr-3',
    });
    runtimeEvents.publish.mockResolvedValue({ eventId: 3 });
    const channel = await createAppChannel({} as never);
    const secretText = 'token=sk-live-abc1234567890 super-secret body';

    await channel.sendProgressUpdate('app:demo:conversation', secretText, {
      done: false,
    });

    const publishInput = runtimeEvents.publish.mock.calls.at(-1)?.[0] as {
      payload: { canonicalText: Record<string, unknown> };
    };
    const canonicalText = publishInput.payload.canonicalText;
    const serializedMetadata = JSON.stringify(canonicalText);
    expect(serializedMetadata).not.toContain(secretText);
    expect(serializedMetadata).not.toContain('sk-live-abc1234567890');
    expect(canonicalText).toEqual(
      expect.objectContaining({
        hasContent: true,
      }),
    );
    expect(canonicalText).not.toHaveProperty('preview');
    expect(canonicalText).not.toHaveProperty('previewTruncated');
  });

  it('publishes action-only progress affordances for app clients', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-1',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getAppResponseRoute.mockResolvedValue({
      sessionId: 'session-1',
      threadId: null,
      responseMode: 'sse',
      webhookId: null,
      correlationId: 'corr-4',
    });
    runtimeEvents.publish.mockResolvedValue({ eventId: 4 });
    const channel = await createAppChannel({} as never);

    await channel.sendProgressUpdate('app:demo:conversation', '', {
      actionOnly: true,
      actionAffordances: [
        { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
      ],
    });

    expect(runtimeEvents.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.SESSION_PROGRESS,
        payload: expect.objectContaining({
          text: '',
          actionOnly: true,
          actionAffordances: [
            { kind: 'live_turn_stop', label: 'Stop', actionToken: 'token-1' },
          ],
        }),
      }),
    );
  });

  it('publishes rich descriptors as structured ordered events for app clients', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-1',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getAppResponseRoute.mockResolvedValue({
      sessionId: 'session-1',
      threadId: 'thread-5',
      responseMode: 'sse',
      webhookId: null,
      correlationId: 'corr-5',
    });
    runtimeEvents.publish.mockResolvedValue({ eventId: 5 });
    const channel = await createAppChannel({} as never);

    await expect(
      (channel as any).renderRichInteraction('app:demo:conversation', {
        threadId: 'thread-5',
        descriptor: {
          id: 'status-1',
          title: 'Run status',
          fallbackText: 'Run status: qualifying leads',
          rich: {
            kind: 'status',
            fallbackText: 'Run status: qualifying leads',
            payload: { state: 'running' },
          },
        },
      }),
    ).resolves.toBe(true);

    expect(runtimeEvents.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        payload: expect.objectContaining({
          kind: 'rich_interaction',
          threadId: 'thread-5',
          descriptor: expect.objectContaining({
            id: 'status-1',
            rich: expect.objectContaining({
              kind: 'status',
              fallbackText: 'Run status: qualifying leads',
            }),
          }),
          fallbackText: 'Run status: qualifying leads',
          orderedEnvelope: expect.objectContaining({
            sequence: 1,
            kind: 'rich_interaction',
          }),
        }),
      }),
    );
  });
});
