import { normalizeRuntimeEventConversationId, normalizeRuntimeEventThreadId, } from '../../domain/events/runtime-event-conversation.js';
import { runtimeEventMatchesFilter } from '../../domain/events/runtime-event-filter.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { notifyWebhookDeliveryReady } from './webhook-delivery-wakeup.js';
export class RuntimeEventExchange {
    repository;
    notifier;
    constructor(repository, notifier) {
        this.repository = repository;
        this.notifier = notifier;
    }
    async publish(input) {
        const event = await this.repository.appendRuntimeEvent(normalizeRuntimeEventPublishInput(input));
        try {
            await this.notifier.notify(event);
        }
        catch {
            // Wakeups are best-effort; durable consumers recover by cursor polling.
        }
        notifyWebhookDeliveryReady();
        return event;
    }
    async publishWithLiveAdmissionMessage(input, admission) {
        const repository = this
            .repository;
        const normalized = normalizeRuntimeEventPublishInput(input);
        if (!repository.appendRuntimeEventAndStoreLiveAdmission) {
            throw new Error('Runtime event repository cannot atomically store live admission messages.');
        }
        const result = await repository.appendRuntimeEventAndStoreLiveAdmission(normalized, admission);
        try {
            await this.notifier.notify(result.event);
        }
        catch {
            // Wakeups are best-effort; durable consumers recover by cursor polling.
        }
        notifyWebhookDeliveryReady();
        return result;
    }
    list(filter) {
        return this.repository.listRuntimeEvents(normalizeRuntimeEventFilter(filter));
    }
    subscribe(filter) {
        return new DurableRuntimeEventSubscription(this.repository, this.notifier, normalizeRuntimeEventFilter(filter));
    }
}
function normalizeRuntimeEventPublishInput(input) {
    const conversationId = normalizeRuntimeEventConversationId(input.conversationId);
    const threadId = normalizeRuntimeEventThreadId({
        conversationId,
        threadId: input.threadId,
    });
    return conversationId === input.conversationId && threadId === input.threadId
        ? input
        : { ...input, conversationId, threadId };
}
function normalizeRuntimeEventFilter(filter) {
    const conversationId = normalizeRuntimeEventConversationId(filter.conversationId);
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
class DurableRuntimeEventSubscription {
    repository;
    filter;
    closed = false;
    cursor;
    wakeup = null;
    unsubscribe;
    constructor(repository, notifier, filter) {
        this.repository = repository;
        this.filter = filter;
        this.cursor = filter.afterEventId;
        try {
            this.unsubscribe = notifier.subscribe(() => {
                this.wakeup?.();
                this.wakeup = null;
            }, filter);
        }
        catch {
            this.unsubscribe = () => undefined;
        }
    }
    async next(options = {}) {
        if (this.closed)
            return [];
        const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000);
        const deadline = currentTimeMs() + timeoutMs;
        while (!this.closed) {
            const events = await this.repository.listRuntimeEvents({
                ...this.filter,
                afterEventId: this.cursor,
            });
            if (events.length > 0) {
                this.cursor = events[events.length - 1].eventId;
                return events;
            }
            const remaining = deadline - currentTimeMs();
            if (remaining <= 0)
                return [];
            await this.waitForWakeup(Math.min(remaining, MAX_SUBSCRIPTION_WAKE_WAIT_MS));
        }
        return [];
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.unsubscribe();
        this.wakeup?.();
        this.wakeup = null;
    }
    waitForWakeup(timeoutMs) {
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
export class InMemoryRuntimeEventNotifier {
    listeners = new Map();
    notifiedEvents = [];
    async notify(event) {
        this.notifiedEvents.push(event);
        for (const [listener, filter] of [...this.listeners]) {
            if (filter && !runtimeEventMatchesFilter(event, filter))
                continue;
            listener();
        }
    }
    subscribe(listener, filter) {
        this.listeners.set(listener, filter);
        return () => {
            this.listeners.delete(listener);
        };
    }
}
