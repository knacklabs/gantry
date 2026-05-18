import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  parseRuntimeEventWakeup,
  PostgresRuntimeEventNotifier,
} from '@core/adapters/storage/postgres/runtime-event-notifier.postgres.js';
import type { RuntimeEvent } from '@core/domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

class FakeListenClient extends EventEmitter {
  readonly query = vi.fn(async () => undefined);
  readonly release = vi.fn();
}

describe('PostgresRuntimeEventNotifier', () => {
  it('treats failed NOTIFY as a wakeup loss rather than event durability loss', async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async () => {
        throw new Error('notify unavailable');
      }),
    };
    const notifier = new PostgresRuntimeEventNotifier(pool as never);
    const event: RuntimeEvent = {
      eventId: 12 as never,
      appId: 'app-one' as never,
      sessionId: 'session-one' as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      payload: { text: 'already persisted' },
      createdAt: '2026-05-18T00:00:00.000Z',
    };

    await expect(notifier.notify(event)).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      'gantry_runtime_events',
      expect.stringContaining('"eventId":12'),
    ]);
  });

  it('parses only valid runtime event wakeups', () => {
    expect(
      parseRuntimeEventWakeup(
        JSON.stringify({
          eventId: 1,
          appId: 'app:test',
          complete: true,
          eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
        }),
      ),
    ).toMatchObject({
      eventId: 1,
      appId: 'app:test',
      complete: true,
      eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
    });
    expect(parseRuntimeEventWakeup('{')).toBeNull();
    expect(
      parseRuntimeEventWakeup(JSON.stringify({ appId: 'app:test' })),
    ).toBeNull();
  });

  it('filters wakeups and reconnects after listener client failure', async () => {
    vi.useFakeTimers();
    const first = new FakeListenClient();
    const second = new FakeListenClient();
    const pool = {
      connect: vi.fn(async () =>
        pool.connect.mock.calls.length === 1 ? first : second,
      ),
      query: vi.fn(async () => undefined),
    };
    const notifier = new PostgresRuntimeEventNotifier(pool as never);
    const listener = vi.fn();

    notifier.subscribe(listener, {
      appId: 'app-one' as never,
      sessionId: 'session-one' as never,
    });
    await vi.waitFor(() =>
      expect(first.query).toHaveBeenCalledWith('LISTEN gantry_runtime_events'),
    );

    first.emit('notification', {
      channel: 'gantry_runtime_events',
      payload: JSON.stringify({
        eventId: 1,
        appId: 'app-two',
        complete: true,
        eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      }),
    });
    expect(listener).not.toHaveBeenCalled();

    first.emit('notification', {
      channel: 'gantry_runtime_events',
      payload: JSON.stringify({
        eventId: 1,
        appId: 'app-one',
        complete: true,
        eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      }),
    });
    expect(listener).not.toHaveBeenCalled();

    first.emit('notification', {
      channel: 'gantry_runtime_events',
      payload: JSON.stringify({
        eventId: 2,
        appId: 'app-one',
        complete: true,
        sessionId: 'session-two',
        eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      }),
    });
    expect(listener).not.toHaveBeenCalled();

    first.emit('notification', {
      channel: 'gantry_runtime_events',
      payload: JSON.stringify({
        eventId: 3,
        appId: 'app-one',
        complete: true,
        sessionId: 'session-one',
        eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      }),
    });
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();

    first.emit('notification', {
      channel: 'gantry_runtime_events',
      payload: JSON.stringify({
        eventId: 4,
        appId: 'app-one',
        complete: false,
        eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
      }),
    });
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();

    first.emit('error', new Error('listener lost'));
    expect(first.release).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(second.query).toHaveBeenCalledWith('LISTEN gantry_runtime_events'),
    );

    await notifier.close();
    vi.useRealTimers();
  });
});
