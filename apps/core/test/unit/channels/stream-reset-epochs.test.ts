import { describe, expect, it } from 'vitest';

import {
  StreamGenerationFence,
  StreamResetEpochs,
} from '@core/channels/stream-reset-epochs.js';

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

describe('StreamGenerationFence', () => {
  it('keeps each thread on its own generation and refuses stale or finished chunks', () => {
    const fence = new StreamGenerationFence();
    const dropped: string[] = [];
    const accept = (key: string, generation: number) =>
      fence.accept(key, generation, () => dropped.push(key));

    expect(accept('chat:11', 1)).toBe(true);
    expect(accept('chat:22', 2)).toBe(true);
    expect(accept('chat:11', 1)).toBe(true);
    expect(fence.isCurrent('chat:11', 1)).toBe(true);
    expect(dropped).toEqual([]);

    expect(accept('chat:11', 3)).toBe(true);
    expect(dropped).toEqual(['chat:11']);
    expect(accept('chat:11', 1)).toBe(false);
    expect(fence.isCurrent('chat:11', 1)).toBe(false);

    fence.markDone('chat:11', 3);
    expect(accept('chat:11', 3)).toBe(false);
    expect(fence.isCurrent('chat:11', 3)).toBe(false);
    expect(accept('chat:22', 2)).toBe(true);
  });
});
