import { beforeEach, describe, expect, it, vi } from 'vitest';

const release = vi.hoisted(() => vi.fn(async () => undefined));
const loadRuntimeSettings = vi.hoisted(() => vi.fn());
const createEmbeddingProvider = vi.hoisted(() =>
  vi.fn(() => ({
    isEnabled: () => true,
    validateConfiguration: () => undefined,
    embedMany: vi.fn(),
    embedOne: vi.fn(),
  })),
);
const acquireRuntimeStorageForRuntimeHome = vi.hoisted(() =>
  vi.fn(async () => ({
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
);

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  acquireRuntimeStorageForRuntimeHome,
  getRuntimeStorage: vi.fn(),
}));

vi.mock('@core/memory/memory-embeddings.js', () => ({
  createEmbeddingProvider,
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
  createEmbeddingProvider.mockClear();
  acquireRuntimeStorageForRuntimeHome.mockClear();
  loadRuntimeSettings.mockReset();
});

describe('brain runtime storage lifecycle', () => {
  it('releases command-owned storage when construction fails', async () => {
    const settings = createDefaultRuntimeSettings();
    Object.defineProperty(settings, 'conversations', {
      get: () => {
        throw new Error('invalid conversation settings');
      },
    });
    loadRuntimeSettings.mockReturnValueOnce(settings);

    await expect(
      openBrainFromHome('/tmp/gantry-brain-failure'),
    ).rejects.toThrow('invalid conversation settings');

    expect(release).toHaveBeenCalledOnce();
    expect(acquireRuntimeStorageForRuntimeHome.mock.calls[0]?.[0]).toBe(
      '/tmp/gantry-brain-failure',
    );
    expect(acquireRuntimeStorageForRuntimeHome.mock.calls[0]?.[1]).toBe(
      settings,
    );
  });

  it('surfaces construction and cleanup failures together', async () => {
    const settings = createDefaultRuntimeSettings();
    Object.defineProperty(settings, 'conversations', {
      get: () => {
        throw new Error('invalid conversation settings');
      },
    });
    loadRuntimeSettings.mockReturnValueOnce(settings);
    release.mockRejectedValueOnce(new Error('storage cleanup failed'));

    await expect(
      openBrainFromHome('/tmp/gantry-brain-double-failure'),
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'invalid conversation settings' }),
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

  it('passes the requested runtime home broker config into brain embeddings', async () => {
    const first = createDefaultRuntimeSettings();
    first.memory.embeddings.enabled = true;
    first.memory.embeddings.provider = 'openai';
    first.credentialBroker.mode = 'none';
    first.credentialBroker.gateway.bindHost = '127.0.0.1';
    const second = createDefaultRuntimeSettings();
    second.memory.embeddings.enabled = true;
    second.memory.embeddings.provider = 'openai';
    second.credentialBroker.mode = 'gantry';
    second.credentialBroker.gateway.bindHost = '::1';
    loadRuntimeSettings.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const openedFirst = await openBrainFromHome('/tmp/gantry-brain-home-a');
    const openedSecond = await openBrainFromHome('/tmp/gantry-brain-home-b');
    await openedFirst.close();
    await openedSecond.close();

    expect(createEmbeddingProvider).toHaveBeenNthCalledWith(
      1,
      'openai',
      expect.objectContaining({
        credentialBrokerConfig: {
          mode: 'none',
          gatewayBindHost: '127.0.0.1',
        },
      }),
    );
    expect(createEmbeddingProvider).toHaveBeenNthCalledWith(
      2,
      'openai',
      expect.objectContaining({
        credentialBrokerConfig: {
          mode: 'gantry',
          gatewayBindHost: '::1',
        },
      }),
    );
  });
});
