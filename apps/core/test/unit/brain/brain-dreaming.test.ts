import { describe, expect, it } from 'vitest';

import { runBrainDreamBatch } from '@core/brain/brain-dreaming.js';

describe('brain dreaming dependencies', () => {
  it('requires a review repository for non-observer dreaming', async () => {
    await expect(
      runBrainDreamBatch({
        brain: {} as never,
        repository: {} as never,
        appId: 'default',
      } as never),
    ).rejects.toThrow('Brain dreaming requires a review repository.');
  });
});
