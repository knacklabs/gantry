import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { SessionTypingTracker } from '../../../../../packages/sdk/src/session-events.js';

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

const appOptions = (generation = 1) =>
  ({ liveUxBindingGeneration: () => generation }) as never;

describe('app channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to construct an app binding without a durable producer generation source', async () => {
    await expect(createAppChannel({} as never)).rejects.toThrow(
      'App channel requires a durable runtime lease generation binding',
    );
  });

  it('keeps a late stale typing event from overriding newer terminal off', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-1',
      agentId: 'agent-1',
      canonicalConversationId: 'conversation-1',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getAppResponseRoute.mockResolvedValue(null);
    let releaseStart: (() => void) | undefined;
    const committed: Array<{
      eventId: number;
      eventType: string;
      sessionId: string;
      payload: unknown;
    }> = [];
    runtimeEvents.publish.mockImplementation(async (event) => {
      const isTyping = (event.payload as { isTyping: boolean }).isTyping;
      if (isTyping) {
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
      }
      const committedEvent = {
        eventId: committed.length + 1,
        eventType: event.eventType,
        sessionId: 'session-1',
        payload: event.payload,
      };
      committed.push(committedEvent);
      return committedEvent;
    });
    const app = await createAppChannel(appOptions());

    const staleStart = app.setTyping?.('app:demo:conversation', true);
    await vi.waitFor(() =>
      expect(runtimeEvents.publish).toHaveBeenCalledOnce(),
    );
    await app.setTyping?.('app:demo:conversation', false);
    releaseStart?.();
    await staleStart;

    expect(
      committed.map(
        (event) => (event.payload as { isTyping: boolean }).isTyping,
      ),
    ).toEqual([false, true]);
    const tracker = new SessionTypingTracker();
    const applied = committed.filter((event) => tracker.apply(event));
    expect(
      applied.map((event) => (event.payload as { isTyping: boolean }).isTyping),
    ).toEqual([false]);
  });

  it('partitions typing order by thread within one consumer', () => {
    const event = (threadId: string, sequence: number) => ({
      eventId: sequence,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId,
      payload: {
        isTyping: true,
        orderedEnvelope: {
          generation: 1,
          sequence,
          kind: 'typing',
        },
      },
    });
    const tracker = new SessionTypingTracker();

    expect(tracker.apply(event('thread-a', 2))).toBe(true);
    expect(tracker.apply(event('thread-b', 1))).toBe(true);
    expect(tracker.apply(event('thread-a', 1))).toBe(false);
  });

  it('accepts legacy typing only before enveloped state exists for the target', () => {
    const tracker = new SessionTypingTracker();
    const event = (payload: Record<string, unknown>, eventId: number) => ({
      eventId,
      eventType: 'session.typing',
      sessionId: 'session-1',
      threadId: 'thread-a',
      payload,
    });

    expect(tracker.apply(event({ isTyping: true }, 1))).toBe(true);
    expect(
      tracker.apply(
        event(
          {
            isTyping: false,
            orderedEnvelope: { generation: 1, sequence: 2, kind: 'typing' },
          },
          2,
        ),
      ),
    ).toBe(true);
    expect(tracker.apply(event({ isTyping: true }, 3))).toBe(false);
    expect(tracker.isTyping('session-1', 'thread-a')).toBe(false);
  });

  it('orders replacement producers by durable lease epoch despite clock rollback and A-B-A delivery', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-1',
      agentId: 'agent-1',
      canonicalConversationId: 'conversation-1',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getAppResponseRoute.mockResolvedValue(null);
    const committed: Array<{
      eventId: number;
      eventType: string;
      sessionId: string;
      payload: unknown;
    }> = [];
    runtimeEvents.publish.mockImplementation(async (event) => {
      const committedEvent = {
        eventId: committed.length + 1,
        eventType: event.eventType,
        sessionId: 'session-1',
        payload: event.payload,
      };
      committed.push(committedEvent);
      return committedEvent;
    });
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(1_000);
    const firstProducer = await createAppChannel(appOptions(1));
    await firstProducer.setTyping?.('app:demo:conversation', true);
    const replacementProducer = await createAppChannel(appOptions(2));
    await replacementProducer.setTyping?.('app:demo:conversation', false);
    await firstProducer.setTyping?.('app:demo:conversation', true);
    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();

    const tracker = new SessionTypingTracker();
    expect(tracker.apply(committed[0]!)).toBe(true);
    expect(tracker.apply(committed[1]!)).toBe(true);
    expect(tracker.apply(committed[2]!)).toBe(false);
    expect(tracker.isTyping('session-1')).toBe(false);
    const generations = committed.map(
      (event) =>
        (event.payload as { orderedEnvelope: { generation: unknown } })
          .orderedEnvelope.generation,
    );
    expect(generations).toEqual([1, 2, 1]);
  });

  it('publishes typing against the requested thread target', async () => {
    controlRepo.getAppSessionByChatJid.mockResolvedValue({
      sessionId: 'session-1',
      appId: 'app-1',
      agentId: 'agent-1',
      canonicalConversationId: 'conversation-1',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    });
    controlRepo.getAppResponseRoute.mockResolvedValue(null);
    runtimeEvents.publish.mockResolvedValue({ eventId: 1 });
    const app = await createAppChannel(appOptions());

    await app.setTyping?.('app:demo:conversation', true, {
      threadId: 'thread-a',
    });

    expect(controlRepo.getAppResponseRoute).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-a',
    });
    expect(runtimeEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-a',
        payload: expect.objectContaining({ threadId: 'thread-a' }),
      }),
    );
  });

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
    const channel = await createAppChannel(appOptions());

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
    const channel = await createAppChannel(appOptions());
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
    const channel = await createAppChannel(appOptions());
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
    const channel = await createAppChannel(appOptions());

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

  it('keeps replace-only stall updates as progress events, never outbound messages', async () => {
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
      correlationId: 'corr-stall',
    });
    runtimeEvents.publish.mockResolvedValue({ eventId: 5 });
    const channel = await createAppChannel(appOptions());
    const callsBefore = runtimeEvents.publish.mock.calls.length;

    const landed = await channel.sendProgressUpdate(
      'app:demo:conversation',
      'Still working',
      { replaceOnly: true },
    );

    expect(landed).toBe(true);
    const newCalls = runtimeEvents.publish.mock.calls.slice(callsBefore);
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]?.[0]).toEqual(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.SESSION_PROGRESS,
        payload: expect.objectContaining({ text: 'Still working' }),
      }),
    );
    expect(newCalls).not.toContainEqual([
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      }),
    ]);
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
    const channel = await createAppChannel(appOptions());

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
