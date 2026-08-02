import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryRuntimeEventNotifier,
  RuntimeEventExchange,
} from '@core/application/runtime-events/runtime-event-exchange.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventId,
  RuntimeEventPublishInput,
} from '@core/domain/events/events.js';
import type { RuntimeEventRepository } from '@core/domain/ports/repositories.js';
import { subscribeWebhookDeliveryReady } from '@core/application/runtime-events/webhook-delivery-wakeup.js';

class MemoryRuntimeEventRepository implements RuntimeEventRepository {
  readonly events: RuntimeEvent[] = [];
  private nextId = 1;

  async appendRuntimeEvent(
    input: RuntimeEventPublishInput,
  ): Promise<RuntimeEvent> {
    const event: RuntimeEvent = {
      eventId: this.nextId++ as RuntimeEventId,
      appId: input.appId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      runId: input.runId,
      jobId: input.jobId,
      triggerId: input.triggerId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      eventType: input.eventType,
      actor: input.actor,
      correlationId: input.correlationId ?? undefined,
      responseMode: input.responseMode ?? undefined,
      webhookId: input.webhookId ?? undefined,
      payload: input.payload,
      createdAt: input.createdAt ?? '2026-04-29T00:00:00.000Z',
    };
    this.events.push(event);
    return event;
  }

  async listRuntimeEvents(filter: RuntimeEventFilter): Promise<RuntimeEvent[]> {
    return this.events
      .filter((event) => event.appId === filter.appId)
      .filter(
        (event) =>
          filter.afterEventId === undefined ||
          event.eventId > filter.afterEventId,
      )
      .filter(
        (event) =>
          filter.sessionId === undefined ||
          event.sessionId === filter.sessionId,
      )
      .filter(
        (event) => filter.runId === undefined || event.runId === filter.runId,
      )
      .filter(
        (event) => filter.jobId === undefined || event.jobId === filter.jobId,
      )
      .filter(
        (event) =>
          filter.triggerId === undefined ||
          event.triggerId === filter.triggerId,
      )
      .filter(
        (event) =>
          filter.conversationId === undefined ||
          event.conversationId === filter.conversationId,
      )
      .filter(
        (event) =>
          filter.threadId === undefined || event.threadId === filter.threadId,
      )
      .filter(
        (event) =>
          !filter.eventTypes?.length ||
          filter.eventTypes.includes(event.eventType),
      )
      .slice(0, filter.limit ?? 100);
  }

  async queryUsage() {
    return [];
  }
}

describe('RuntimeEventExchange', () => {
  it('persists before notifying subscribers', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const notifier = new InMemoryRuntimeEventNotifier();
    const exchange = new RuntimeEventExchange(repository, notifier);

    const event = await exchange.publish({
      appId: 'app:test' as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      payload: { text: 'done' },
    });

    expect(repository.events).toEqual([event]);
    expect(notifier.notifiedEvents).toEqual([event]);
  });

  it('wakes webhook delivery flushes after every runtime event commit', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const notifier = new InMemoryRuntimeEventNotifier();
    const exchange = new RuntimeEventExchange(repository, notifier);
    const listener = vi.fn();
    const unsubscribe = subscribeWebhookDeliveryReady(listener);
    try {
      await exchange.publish({
        appId: 'app:test' as never,
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        actor: 'agent',
        responseMode: 'webhook',
        webhookId: 'wh_1',
        payload: { text: 'done' },
      });
      await exchange.publish({
        appId: 'app:test' as never,
        eventType: RUNTIME_EVENT_TYPES.RUN_COMPLETED,
        actor: 'runtime',
        payload: { status: 'completed' },
      });
    } finally {
      unsubscribe();
    }

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('can co-commit accepted messages and live admission before notifying subscribers', async () => {
    const repository =
      new MemoryRuntimeEventRepository() as MemoryRuntimeEventRepository & {
        appendRuntimeEventAndStoreLiveAdmission: ReturnType<typeof vi.fn>;
      };
    repository.appendRuntimeEventAndStoreLiveAdmission = vi.fn(
      async (input, admission) => {
        const event = await repository.appendRuntimeEvent(input);
        return {
          event,
          liveAdmissionResult: {
            outcome: 'enqueued',
            item: {
              id: `admission:${admission.message.id}`,
              state: 'queued',
            },
          },
        };
      },
    );
    const notifier = new InMemoryRuntimeEventNotifier();
    const exchange = new RuntimeEventExchange(repository, notifier);

    const result = await exchange.publishWithLiveAdmissionMessage(
      {
        appId: 'app:test' as never,
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
        actor: 'sdk',
        payload: { text: 'accepted' },
      },
      {
        message: {
          id: 'message-1',
          chat_jid: 'app:test:conversation',
          sender: 'sdk',
          sender_name: 'SDK',
          content: 'accepted',
          timestamp: '2026-04-29T00:00:00.000Z',
        },
        liveAdmission: { appId: 'default' },
      },
    );

    expect(
      repository.appendRuntimeEventAndStoreLiveAdmission,
    ).toHaveBeenCalledOnce();
    expect(result.liveAdmissionResult?.item).toMatchObject({
      id: 'admission:message-1',
      state: 'queued',
    });
    expect(notifier.notifiedEvents).toEqual([result.event]);
  });

  it('returns the durable event when the live wakeup notifier fails', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const exchange = new RuntimeEventExchange(repository, {
      notify: vi.fn(async () => {
        throw new Error('wakeup failed');
      }),
      subscribe: vi.fn(() => () => undefined),
    });

    await expect(
      exchange.publish({
        appId: 'app:test' as never,
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        actor: 'agent',
        payload: { text: 'durable' },
      }),
    ).resolves.toMatchObject({
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      payload: { text: 'durable' },
    });
    expect(repository.events).toHaveLength(1);
  });

  it('moves raw provider conversation ids into payload route context before persistence', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const notifier = new InMemoryRuntimeEventNotifier();
    const exchange = new RuntimeEventExchange(repository, notifier);

    const event = await exchange.publish({
      appId: 'app:test' as never,
      conversationId: 'tg:-100123' as never,
      eventType: RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
      actor: 'runner',
      payload: {},
    });

    expect(event.conversationId).toBeUndefined();
    expect(repository.events[0]?.conversationId).toBeUndefined();
    expect(notifier.notifiedEvents[0]?.conversationId).toBeUndefined();
    expect(event.payload).toEqual({ conversationJid: 'tg:-100123' });
  });

  it('moves raw provider thread ids into payload route context before persistence', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const notifier = new InMemoryRuntimeEventNotifier();
    const exchange = new RuntimeEventExchange(repository, notifier);

    const event = await exchange.publish({
      appId: 'app:test' as never,
      conversationId: 'tg:-100123' as never,
      threadId: '2771' as never,
      eventType: RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
      actor: 'runner',
      payload: {},
    });

    expect(event.conversationId).toBeUndefined();
    expect(event.threadId).toBeUndefined();
    expect(repository.events[0]?.threadId).toBeUndefined();
    expect(notifier.notifiedEvents[0]?.threadId).toBeUndefined();
    expect(event.payload).toEqual({
      conversationJid: 'tg:-100123',
      threadId: '2771',
    });
  });

  it('preserves canonical conversation ids in list filters', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const exchange = new RuntimeEventExchange(
      repository,
      new InMemoryRuntimeEventNotifier(),
    );
    await exchange.publish({
      appId: 'app:test' as never,
      conversationId: 'conversation:tg:-100123' as never,
      eventType: RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
      actor: 'runner',
      payload: {},
    });

    await expect(
      exchange.list({
        appId: 'app:test' as never,
        conversationId: 'conversation:tg:-100123' as never,
      }),
    ).resolves.toHaveLength(1);
  });

  it('preserves canonical thread ids in list filters', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const exchange = new RuntimeEventExchange(
      repository,
      new InMemoryRuntimeEventNotifier(),
    );
    await exchange.publish({
      appId: 'app:test' as never,
      conversationId: 'conversation:tg:-100123' as never,
      threadId: 'thread:tg:-100123:2771' as never,
      eventType: RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
      actor: 'runner',
      payload: {},
    });

    await expect(
      exchange.list({
        appId: 'app:test' as never,
        conversationId: 'conversation:tg:-100123' as never,
        threadId: 'thread:tg:-100123:2771' as never,
      }),
    ).resolves.toHaveLength(1);
  });

  it('replays from cursor before waiting for live wakeups', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const notifier = new InMemoryRuntimeEventNotifier();
    const exchange = new RuntimeEventExchange(repository, notifier);
    await exchange.publish({
      appId: 'app:test' as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      payload: { text: 'existing' },
    });

    const subscription = exchange.subscribe({ appId: 'app:test' as never });

    await expect(subscription.next({ timeoutMs: 1 })).resolves.toMatchObject([
      {
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        payload: { text: 'existing' },
      },
    ]);
    subscription.close();
  });

  it('recovers missed wakeups by polling durable events after the cursor', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const exchange = new RuntimeEventExchange(
      repository,
      new InMemoryRuntimeEventNotifier(),
    );
    await repository.appendRuntimeEvent({
      appId: 'app:test' as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      payload: { text: 'before cursor' },
    });
    const missedEvent = await repository.appendRuntimeEvent({
      appId: 'app:test' as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      payload: { text: 'missed notify' },
    });

    const subscription = exchange.subscribe({
      appId: 'app:test' as never,
      afterEventId: 1 as RuntimeEventId,
    });

    await expect(subscription.next({ timeoutMs: 0 })).resolves.toMatchObject([
      {
        eventId: missedEvent.eventId,
        payload: { text: 'missed notify' },
      },
    ]);
    subscription.close();
  });

  it('polls durable events when wakeup subscription registration fails', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const exchange = new RuntimeEventExchange(repository, {
      notify: vi.fn(async () => undefined),
      subscribe: vi.fn(() => {
        throw new Error('listen unavailable');
      }),
    });
    const event = await repository.appendRuntimeEvent({
      appId: 'app:test' as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      payload: { text: 'poll only' },
    });

    const subscription = exchange.subscribe({ appId: 'app:test' as never });

    await expect(subscription.next({ timeoutMs: 0 })).resolves.toMatchObject([
      {
        eventId: event.eventId,
        payload: { text: 'poll only' },
      },
    ]);
    subscription.close();
  });

  it('delivers the same live event to multiple subscribers', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const notifier = new InMemoryRuntimeEventNotifier();
    const exchange = new RuntimeEventExchange(repository, notifier);
    const first = exchange.subscribe({ appId: 'app:test' as never });
    const second = exchange.subscribe({ appId: 'app:test' as never });

    const firstNext = first.next({ timeoutMs: 1000 });
    const secondNext = second.next({ timeoutMs: 1000 });
    await exchange.publish({
      appId: 'app:test' as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      actor: 'runtime',
      payload: { ok: true },
    });

    await expect(firstNext).resolves.toMatchObject([
      { eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED },
    ]);
    await expect(secondNext).resolves.toMatchObject([
      { eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED },
    ]);
    first.close();
    second.close();
  });

  it('returns no events after a subscription is closed', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const exchange = new RuntimeEventExchange(
      repository,
      new InMemoryRuntimeEventNotifier(),
    );
    const subscription = exchange.subscribe({ appId: 'app:test' as never });

    subscription.close();

    await expect(subscription.next({ timeoutMs: 0 })).resolves.toEqual([]);
  });

  it('isolates filters by app, session, run, job, trigger, conversation, thread, and event type', async () => {
    const repository = new MemoryRuntimeEventRepository();
    const exchange = new RuntimeEventExchange(
      repository,
      new InMemoryRuntimeEventNotifier(),
    );
    await exchange.publish({
      appId: 'app:test' as never,
      sessionId: 'session:1' as never,
      runId: 'run:1' as never,
      jobId: 'job:1' as never,
      triggerId: 'trigger:1',
      conversationId: 'conversation:1' as never,
      threadId: 'thread:1' as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      actor: 'runtime',
      payload: {},
    });
    await exchange.publish({
      appId: 'app:test' as never,
      sessionId: 'session:2' as never,
      runId: 'run:2' as never,
      jobId: 'job:2' as never,
      triggerId: 'trigger:2',
      conversationId: 'conversation:2' as never,
      threadId: 'thread:2' as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_FAILED,
      actor: 'runtime',
      payload: {},
    });
    await exchange.publish({
      appId: 'app:other' as never,
      sessionId: 'session:1' as never,
      runId: 'run:1' as never,
      jobId: 'job:1' as never,
      threadId: 'thread:1' as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      actor: 'runtime',
      payload: {},
    });

    await expect(
      exchange.list({
        appId: 'app:test' as never,
        sessionId: 'session:1' as never,
        runId: 'run:1' as never,
        jobId: 'job:1' as never,
        triggerId: 'trigger:1',
        conversationId: 'conversation:1' as never,
        threadId: 'thread:1' as never,
        eventTypes: [RUNTIME_EVENT_TYPES.JOB_COMPLETED],
      }),
    ).resolves.toHaveLength(1);
  });
});
