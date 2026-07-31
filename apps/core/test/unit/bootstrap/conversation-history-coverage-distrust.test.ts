import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConversationHistoryCoverageDistrust,
  HISTORY_COVERAGE_DISTRUST_MAX_RETRY_MS,
} from '@core/app/bootstrap/conversation-history-coverage-distrust.js';
import type { ConversationHistoryCoverageRepository } from '@core/domain/ports/conversation-history-coverage.js';

describe('ConversationHistoryCoverageDistrust', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets the in-memory epoch before starting the durable bump', async () => {
    let service!: ConversationHistoryCoverageDistrust;
    const bumpProviderGeneration = vi.fn(async () => {
      expect(service.readEpoch('slack-one')).toEqual({
        current: 1,
        durable: 0,
      });
      return 1;
    });
    service = new ConversationHistoryCoverageDistrust(
      () =>
        ({
          bumpProviderGeneration,
        }) as unknown as ConversationHistoryCoverageRepository,
      { warn: vi.fn() },
    );

    service.distrust(['slack-one']);

    expect(service.readEpoch('slack-one').current).toBe(1);
    expect(bumpProviderGeneration).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(service.readEpoch('slack-one')).toEqual({
        current: 1,
        durable: 1,
      }),
    );
  });

  it('retries a DB outage in the background and lands after recovery', async () => {
    vi.useFakeTimers();
    const bumpProviderGeneration = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(9);
    const service = new ConversationHistoryCoverageDistrust(
      () =>
        ({
          bumpProviderGeneration,
        }) as unknown as ConversationHistoryCoverageRepository,
      { warn: vi.fn() },
    );

    service.distrust(['discord-one']);
    expect(service.readEpoch('discord-one')).toEqual({
      current: 1,
      durable: 0,
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    expect(bumpProviderGeneration).toHaveBeenCalledTimes(3);
    expect(service.readEpoch('discord-one')).toEqual({
      current: 1,
      durable: 1,
    });
    expect(HISTORY_COVERAGE_DISTRUST_MAX_RETRY_MS).toBe(2_000);
  });

  it('coalesces repeated distrust into one retry worker per provider account', async () => {
    vi.useFakeTimers();
    const bumpProviderGeneration = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(2);
    const service = new ConversationHistoryCoverageDistrust(
      () =>
        ({
          bumpProviderGeneration,
        }) as unknown as ConversationHistoryCoverageRepository,
      { warn: vi.fn() },
    );

    service.distrust(['slack-one']);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    service.distrust(['slack-one', 'slack-one', 'slack-one', 'slack-one']);

    expect(bumpProviderGeneration).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);

    expect(bumpProviderGeneration).toHaveBeenCalledTimes(2);
    expect(service.readEpoch('slack-one')).toEqual({
      current: 5,
      durable: 5,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the worker alive when distrust advances during a successful bump', async () => {
    let resolveFirst!: (generation: number) => void;
    const firstBump = new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
    const bumpProviderGeneration = vi
      .fn<() => Promise<number>>()
      .mockReturnValueOnce(firstBump)
      .mockResolvedValueOnce(2);
    const service = new ConversationHistoryCoverageDistrust(
      () =>
        ({
          bumpProviderGeneration,
        }) as unknown as ConversationHistoryCoverageRepository,
      { warn: vi.fn() },
    );

    service.distrust(['discord-one']);
    service.distrust(['discord-one', 'discord-one']);
    resolveFirst(1);

    await vi.waitFor(() =>
      expect(service.readEpoch('discord-one')).toEqual({
        current: 3,
        durable: 3,
      }),
    );
    expect(bumpProviderGeneration).toHaveBeenCalledTimes(2);
  });
});
