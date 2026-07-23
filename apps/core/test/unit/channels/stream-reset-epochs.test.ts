import { describe, expect, it } from 'vitest';

import { StreamResetEpochs } from '@core/channels/stream-reset-epochs.js';

describe('StreamResetEpochs', () => {
  it('prunes completed streams without making a stale reset epoch current', () => {
    const epochs = new StreamResetEpochs();

    for (let index = 0; index < 100; index += 1) {
      const key = `thread-${index}`;
      epochs.current(key);
      epochs.prune(key);
    }

    expect(
      (epochs as unknown as { byKey: Map<string, number> }).byKey.size,
    ).toBe(0);

    const key = 'in-flight-thread';
    const staleEpoch = epochs.current(key);
    epochs.bump(key);
    epochs.prune(key);

    expect(epochs.isCurrent(key, staleEpoch)).toBe(false);
    expect(epochs.current(key)).not.toBe(staleEpoch);

    const disconnectedEpoch = epochs.current('disconnecting-thread');
    epochs.clear();
    expect(epochs.isCurrent('disconnecting-thread', disconnectedEpoch)).toBe(
      false,
    );
  });
});
