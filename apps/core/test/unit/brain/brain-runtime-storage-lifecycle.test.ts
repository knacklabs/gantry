import { beforeEach, describe, expect, it, vi } from 'vitest';

const release = vi.hoisted(() => vi.fn(async () => undefined));
const loadRuntimeSettings = vi.hoisted(() => vi.fn());

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  acquireRuntimeStorage: vi.fn(async () => ({
    storage: {
      service: { db: {} },
      repositories: {
        brainDreamReviews: {},
        outboundDeliveries: {},
        conversations: {},
      },
    },
    owned: true,
    release,
  })),
  getRuntimeStorage: vi.fn(),
}));

vi.mock('@core/config/settings/runtime-settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@core/config/settings/runtime-settings.js')
    >();
  return {
    ...actual,
    loadRuntimeSettings,
  };
});

import { openBrainFromHome } from '@core/brain/brain-runtime.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

beforeEach(() => {
  release.mockClear();
  loadRuntimeSettings.mockReset();
  loadRuntimeSettings.mockImplementation(() => {
    throw new Error('invalid runtime settings');
  });
});

describe('brain runtime storage lifecycle', () => {
  it('releases command-owned storage when construction fails', async () => {
    await expect(
      openBrainFromHome('/tmp/gantry-brain-failure'),
    ).rejects.toThrow('invalid runtime settings');

    expect(release).toHaveBeenCalledOnce();
  });

  it('surfaces construction and cleanup failures together', async () => {
    release.mockRejectedValueOnce(new Error('storage cleanup failed'));

    await expect(
      openBrainFromHome('/tmp/gantry-brain-double-failure'),
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'invalid runtime settings' }),
        expect.objectContaining({ message: 'storage cleanup failed' }),
      ],
    });
  });

  it('keeps successful CLI work successful when normal cleanup fails', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.memory.embeddings.enabled = false;
    loadRuntimeSettings.mockReturnValueOnce(settings);
    release.mockRejectedValueOnce(new Error('storage cleanup failed'));

    const opened = await openBrainFromHome('/tmp/gantry-brain-success');

    await expect(opened.close()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });
});
