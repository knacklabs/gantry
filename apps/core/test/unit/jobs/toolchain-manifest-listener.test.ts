import { describe, expect, it, vi } from 'vitest';

import {
  isManifestListenEnabled,
  PollingManifestWakeupSource,
} from '@core/jobs/toolchain-manifest-listener.js';

describe('toolchain manifest listener mode', () => {
  it('keeps LISTEN enabled by default', () => {
    expect(isManifestListenEnabled({})).toBe(true);
  });

  it.each(['0', 'false'])(
    'uses polling-only reconciliation for %s',
    (value) => {
      expect(
        isManifestListenEnabled({
          GANTRY_TOOLCHAIN_MANIFEST_LISTEN_ENABLED: value,
        }),
      ).toBe(false);
    },
  );

  it.each(['1', 'true'])('keeps LISTEN reconciliation for %s', (value) => {
    expect(
      isManifestListenEnabled({
        GANTRY_TOOLCHAIN_MANIFEST_LISTEN_ENABLED: value,
      }),
    ).toBe(true);
  });

  it('rejects ambiguous values', () => {
    expect(() =>
      isManifestListenEnabled({
        GANTRY_TOOLCHAIN_MANIFEST_LISTEN_ENABLED: 'yes',
      }),
    ).toThrow(/must be true, false, 1, or 0/);
  });

  it('provides a no-connection wake source for interval polling', async () => {
    const source = new PollingManifestWakeupSource();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    unsubscribe();
    await source.close();

    expect(listener).not.toHaveBeenCalled();
  });
});
