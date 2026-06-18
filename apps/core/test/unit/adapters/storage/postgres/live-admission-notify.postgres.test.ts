import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_ADMISSION_CHANNEL,
  PostgresLiveAdmissionNotifier,
  PostgresLiveAdmissionWakeupSource,
} from '@core/adapters/storage/postgres/live-admission-notify.postgres.js';

describe('live admission Postgres wakeups', () => {
  it('publishes a wakeup without work-item payload data', async () => {
    const query = vi.fn(async () => undefined);
    const notifier = new PostgresLiveAdmissionNotifier({ query } as any);

    await notifier.notifyLiveAdmissionWorkItem({
      appId: 'default',
      workItemId: 'live-admission:default:message-1',
    });

    expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      LIVE_ADMISSION_CHANNEL,
      '',
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(
      'live-admission:default:message-1',
    );
  });

  it('wakes subscribers on LISTEN notification and unsubscribes cleanly', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => undefined),
      release: vi.fn(),
    });
    const source = new PostgresLiveAdmissionWakeupSource({
      connect: vi.fn(async () => client),
    } as any);
    const listener = vi.fn();

    const unsubscribe = source.subscribe(listener);
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith(
        `LISTEN ${LIVE_ADMISSION_CHANNEL}`,
      ),
    );

    client.emit('notification', { channel: LIVE_ADMISSION_CHANNEL });
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    client.emit('notification', { channel: LIVE_ADMISSION_CHANNEL });
    expect(listener).toHaveBeenCalledOnce();
    await source.close();
    expect(client.query).toHaveBeenCalledWith(
      `UNLISTEN ${LIVE_ADMISSION_CHANNEL}`,
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('does not reuse a pending LISTEN client after close wins the connect race', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => undefined),
      release: vi.fn(),
    });
    let resolveConnect: (client: typeof client) => void = () => {};
    const connect = vi.fn(
      () =>
        new Promise<typeof client>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const source = new PostgresLiveAdmissionWakeupSource({ connect } as any);

    source.subscribe(vi.fn());
    await source.close();
    resolveConnect(client);

    await vi.waitFor(() => expect(client.release).toHaveBeenCalledOnce());
    expect(client.query).not.toHaveBeenCalled();
  });

  it('wakes subscribers when the LISTEN client fails', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => undefined),
      release: vi.fn(),
    });
    const warn = vi.fn();
    const source = new PostgresLiveAdmissionWakeupSource(
      {
        connect: vi.fn(async () => client),
      } as any,
      warn,
    );
    const listener = vi.fn();

    source.subscribe(listener);
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith(
        `LISTEN ${LIVE_ADMISSION_CHANNEL}`,
      ),
    );

    const err = new Error('socket closed');
    client.emit('error', err);

    expect(warn).toHaveBeenCalledWith(
      { err },
      'Live admission LISTEN client failed',
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(err);

    await source.close();
  });
});
