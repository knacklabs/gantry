import { describe, expect, it, vi } from 'vitest';

import {
  parseSettingsRevisionWakeup,
  PostgresSettingsRevisionNotifier,
  SETTINGS_REVISION_CHANNEL,
} from '@core/config/settings/settings-revision-notify.js';

describe('parseSettingsRevisionWakeup', () => {
  it('parses a well-formed payload', () => {
    expect(
      parseSettingsRevisionWakeup(
        JSON.stringify({ appId: 'default', revision: 7 }),
      ),
    ).toEqual({ appId: 'default', revision: 7 });
  });

  it('rejects malformed or partial payloads', () => {
    expect(parseSettingsRevisionWakeup(undefined)).toBeNull();
    expect(parseSettingsRevisionWakeup('not json')).toBeNull();
    expect(
      parseSettingsRevisionWakeup(JSON.stringify({ appId: 'x' })),
    ).toBeNull();
    expect(
      parseSettingsRevisionWakeup(
        JSON.stringify({ appId: 'x', revision: 'one' }),
      ),
    ).toBeNull();
  });
});

describe('PostgresSettingsRevisionNotifier', () => {
  it('publishes to the settings revision channel', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const notifier = new PostgresSettingsRevisionNotifier({ query } as never);
    await notifier.notifyRevisionChanged({ appId: 'default', revision: 3 });
    expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      SETTINGS_REVISION_CHANNEL,
      JSON.stringify({ appId: 'default', revision: 3 }),
    ]);
  });

  it('swallows a failed NOTIFY and logs (poll fallback recovers)', async () => {
    const query = vi.fn().mockRejectedValue(new Error('down'));
    const logWarn = vi.fn();
    const notifier = new PostgresSettingsRevisionNotifier(
      { query } as never,
      logWarn,
    );
    await expect(
      notifier.notifyRevisionChanged({ appId: 'default', revision: 1 }),
    ).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalled();
  });
});
