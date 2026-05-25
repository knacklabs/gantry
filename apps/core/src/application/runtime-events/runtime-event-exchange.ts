import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventId,
  RuntimeEventPublishInput,
} from '../../domain/events/events.js';
import {
  normalizeRuntimeEventConversationId,
  normalizeRuntimeEventThreadId,
} from '../../domain/events/runtime-event-conversation.js';
import type { RuntimeEventRepository } from '../../domain/ports/repositories.js';
import { runtimeEventMatchesFilter } from '../../domain/events/runtime-event-filter.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';

export interface RuntimeEventNotifier {
  notify(event: RuntimeEvent): Promise<void>;
  subscribe(listener: () => void, filter?: RuntimeEventFilter): () => void;
}

export interface RuntimeEventSubscription {
  next(options?: { timeoutMs?: number }): Promise<RuntimeEvent[]>;
  close(): void;
}

export class RuntimeEventExchange {
  constructor(
    private readonly repository: RuntimeEventRepository,
    private readonly notifier: RuntimeEventNotifier,
  ) {}

  async publish(input: RuntimeEventPublishInput): Promise<RuntimeEvent> {
    const event = await this.repository.appendRuntimeEvent(
      normalizeRuntimeEventPublishInput(input),
    );
    try {
      await this.notifier.notify(event);
    } catch {
      // Wakeups are best-effort; durable consumers recover by cursor polling.
    }
    return event;
  }

  list(filter: RuntimeEventFilter): Promise<RuntimeEvent[]> {
    return this.repository.listRuntimeEvents(
      normalizeRuntimeEventFilter(filter),
    );
  }

  subscribe(filter: RuntimeEventFilter): RuntimeEventSubscription {
    return new DurableRuntimeEventSubscription(
      this.repository,
      this.notifier,
      normalizeRuntimeEventFilter(filter),
    );
  }
}

function normalizeRuntimeEventPublishInput(
  input: RuntimeEventPublishInput,
): RuntimeEventPublishInput {
  const conversationId = normalizeRuntimeEventConversationId(
    input.conversationId,
  );
  const threadId = normalizeRuntimeEventThreadId({
    conversationId,
    threadId: input.threadId,
  });
  return conversationId === input.conversationId && threadId === input.threadId
    ? input
    : { ...input, conversationId, threadId };
}

function normalizeRuntimeEventFilter(
  filter: RuntimeEventFilter,
): RuntimeEventFilter {
  const conversationId = normalizeRuntimeEventConversationId(
    filter.conversationId,
  );
  const threadId = normalizeRuntimeEventThreadId({
    conversationId,
    threadId: filter.threadId,
  });
  return conversationId === filter.conversationId &&
    threadId === filter.threadId
    ? filter
    : { ...filter, conversationId, threadId };
}

const MAX_SUBSCRIPTION_WAKE_WAIT_MS = 15_000;

class DurableRuntimeEventSubscription implements RuntimeEventSubscription {
  private closed = false;
  private cursor: RuntimeEventId | undefined;
  private wakeup: (() => void) | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly repository: RuntimeEventRepository,
    notifier: RuntimeEventNotifier,
    private readonly filter: RuntimeEventFilter,
  ) {
    this.cursor = filter.afterEventId;
    try {
      this.unsubscribe = notifier.subscribe(() => {
        this.wakeup?.();
        this.wakeup = null;
      }, filter);
    } catch {
      this.unsubscribe = () => undefined;
    }
  }

  async next(options: { timeoutMs?: number } = {}): Promise<RuntimeEvent[]> {
    if (this.closed) return [];
    const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000);
    const deadline = currentTimeMs() + timeoutMs;

    while (!this.closed) {
      const events = await this.repository.listRuntimeEvents({
        ...this.filter,
        afterEventId: this.cursor,
      });
      if (events.length > 0) {
        this.cursor = events[events.length - 1]!.eventId;
        return events;
      }
      const remaining = deadline - currentTimeMs();
      if (remaining <= 0) return [];
      await this.waitForWakeup(
        Math.min(remaining, MAX_SUBSCRIPTION_WAKE_WAIT_MS),
      );
    }
    return [];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.wakeup?.();
    this.wakeup = null;
  }

  private waitForWakeup(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.wakeup === resolve) {
          this.wakeup = null;
        }
        resolve();
      }, timeoutMs);
      this.wakeup = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

export class InMemoryRuntimeEventNotifier implements RuntimeEventNotifier {
  private readonly listeners = new Map<
    () => void,
    RuntimeEventFilter | undefined
  >();
  readonly notifiedEvents: RuntimeEvent[] = [];

  async notify(event: RuntimeEvent): Promise<void> {
    this.notifiedEvents.push(event);
    for (const [listener, filter] of [...this.listeners]) {
      if (filter && !runtimeEventMatchesFilter(event, filter)) continue;
      listener();
    }
  }

  subscribe(listener: () => void, filter?: RuntimeEventFilter): () => void {
    this.listeners.set(listener, filter);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
