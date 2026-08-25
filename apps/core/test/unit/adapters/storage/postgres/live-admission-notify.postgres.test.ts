import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_ADMISSION_CHANNEL,
  LIVE_TURN_COMMAND_CHANNEL,
  isLiveWakeupListenEnabled,
  PollingLiveAdmissionWakeupSource,
  PollingLiveTurnCommandWakeupSource,
  PostgresLiveAdmissionNotifier,
  PostgresLiveAdmissionWakeupSource,
  PostgresLiveTurnCommandNotifier,
  PostgresLiveTurnCommandWakeupSource,
} from '@core/adapters/storage/postgres/live-admission-notify.postgres.js';

describe('live admission Postgres wakeups', () => {
  it('keeps LISTEN wakeups enabled by default', () => {
    expect(isLiveWakeupListenEnabled({})).toBe(true);
  });

  it.each(['0', 'false'])('uses polling-only wakeups for %s', (value) => {
    expect(
      isLiveWakeupListenEnabled({
        GANTRY_LIVE_WAKEUP_LISTEN_ENABLED: value,
      }),
    ).toBe(false);
  });

  it.each(['1', 'true'])('keeps LISTEN wakeups for %s', (value) => {
    expect(
      isLiveWakeupListenEnabled({
        GANTRY_LIVE_WAKEUP_LISTEN_ENABLED: value,
      }),
    ).toBe(true);
  });

  it('rejects ambiguous wakeup listener values', () => {
    expect(() =>
      isLiveWakeupListenEnabled({
        GANTRY_LIVE_WAKEUP_LISTEN_ENABLED: 'yes',
      }),
    ).toThrow(/must be true, false, 1, or 0/);
  });

  it('provides connection-free polling wake sources', async () => {
    const admissionSource = new PollingLiveAdmissionWakeupSource();
    const commandSource = new PollingLiveTurnCommandWakeupSource();
    const listener = vi.fn();

    admissionSource.subscribe(listener)();
    commandSource.subscribe(listener)();
    await admissionSource.close();
    await commandSource.close();

    expect(listener).not.toHaveBeenCalled();
  });

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

  it('publishes a live-turn command wakeup without command payload data', async () => {
    const query = vi.fn(async () => undefined);
    const notifier = new PostgresLiveTurnCommandNotifier({ query } as any);

    await notifier.notifyLiveTurnCommand({
      liveTurnId: 'turn-1',
      commandId: 'cmd-1',
    });

    expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      LIVE_TURN_COMMAND_CHANNEL,
      '',
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('cmd-1');
    expect(JSON.stringify(query.mock.calls)).not.toContain('turn-1');
  });

  it('wakes live-turn command subscribers on LISTEN notification', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => undefined),
      release: vi.fn(),
    });
    const source = new PostgresLiveTurnCommandWakeupSource({
      connect: vi.fn(async () => client),
    } as any);
    const listener = vi.fn();

    const unsubscribe = source.subscribe(listener);
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith(
        `LISTEN ${LIVE_TURN_COMMAND_CHANNEL}`,
      ),
    );

    client.emit('notification', { channel: LIVE_TURN_COMMAND_CHANNEL });
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    await source.close();
    expect(client.query).toHaveBeenCalledWith(
      `UNLISTEN ${LIVE_TURN_COMMAND_CHANNEL}`,
    );
  });
});
