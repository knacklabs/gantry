import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cacheShapeKeyOf,
  poolKeyOf,
  type BoundRun,
  type SharedBootRecipe,
  type WarmPoolCapable,
  type WarmWorkerHandle,
} from '@core/application/agent-execution/warm-pool-capable.js';
import { WarmPoolManager } from '@core/runtime/warm-pool-manager.js';

function makeRecipe(
  overrides: Partial<SharedBootRecipe> = {},
): SharedBootRecipe {
  const keyInput = {
    providerId: 'anthropic:claude-agent-sdk',
    appId: 'app-1',
    agentId: 'agent-1',
    persona: 'sales',
    model: 'opus',
    toolSurface: { gantryMcp: ['send_message'], native: ['Read'] },
    mcpSet: ['mcp:shopify-api'],
    thinking: { mode: 'enabled', effort: 'medium' },
    systemPromptVersion: 'prompt-v1',
  } as const;
  const recipe = {
    ...keyInput,
    cwd: '/tmp/agent',
    compiledSystemPrompt: 'shared prompt',
    ...overrides,
  };
  return {
    ...recipe,
    key: overrides.key ?? poolKeyOf(recipe),
  };
}

function makeCapability(now: () => number): {
  capability: WarmPoolCapable;
  recycled: WarmWorkerHandle[];
} {
  let nextWorkerId = 0;
  const recycled: WarmWorkerHandle[] = [];
  const capability: WarmPoolCapable = {
    id: 'anthropic:claude-agent-sdk',
    prepare: async () => {
      throw new Error('not used');
    },
    prewarm: vi.fn(async (recipe) => ({
      id: `worker-${++nextWorkerId}`,
      key: recipe.key,
      cacheShapeKey: cacheShapeKeyOf(recipe),
      bornAt: now(),
      bound: false,
    })),
    bind: async (): Promise<BoundRun> => {
      throw new Error('not used');
    },
    recycle: vi.fn(async (handle) => {
      recycled.push(handle);
    }),
  };
  return { capability, recycled };
}

describe('WarmPoolManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prewarms N workers and reports idle size', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();

    await manager.prewarm(recipe, 2);

    expect(manager.size(recipe.key)).toBe(2);
    expect(capability.prewarm).toHaveBeenCalledTimes(2);
  });

  it('treats repeated prewarm as ensure-size instead of overfilling', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();

    await manager.prewarm(recipe, 2);
    await manager.prewarm(recipe, 2);

    expect(manager.size(recipe.key)).toBe(2);
    expect(capability.prewarm).toHaveBeenCalledTimes(2);
  });

  it('acquires one idle worker atomically and returns null when empty', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();
    await manager.prewarm(recipe, 1);

    const first = manager.acquire(recipe.key);
    const second = manager.acquire(recipe.key);

    expect(first?.id).toBe('worker-1');
    expect(first?.bound).toBe(false);
    expect(second).toBeNull();
    expect(manager.size(recipe.key)).toBe(0);
  });

  it('tracks acquired workers as bound active and replenishes generic capacity', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();
    await manager.prewarm(recipe, 1);

    const acquired = manager.acquire(recipe.key);

    expect(acquired).not.toBeNull();
    expect(manager.inventory(recipe.key)).toMatchObject({
      availableTarget: 1,
      genericAvailable: 0,
      boundActive: 1,
    });
    await vi.waitFor(() =>
      expect(manager.inventory(recipe.key).genericAvailable).toBe(1),
    );
    expect(capability.prewarm).toHaveBeenCalledTimes(2);

    await manager.release(acquired!);

    expect(manager.inventory(recipe.key).boundActive).toBe(0);
    expect(manager.inventory(recipe.key).genericAvailable).toBe(1);
  });

  it('preserves generic workers when bound active workers are at the cap', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      maxBoundWorkers: 1,
    });
    const recipe = makeRecipe();
    await manager.prewarm(recipe, 2);

    const first = manager.acquire(recipe.key);
    const second = manager.acquire(recipe.key);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(manager.inventory(recipe.key)).toMatchObject({
      availableTarget: 2,
      genericAvailable: 1,
      boundActive: 1,
      maxBoundWorkers: 1,
    });

    await manager.release(first!);

    expect(manager.acquire(recipe.key)).not.toBeNull();
  });

  it('hands a size-1 worker to only one concurrent acquirer', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();
    await manager.prewarm(recipe, 1);

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => manager.acquire(recipe.key)),
      Promise.resolve().then(() => manager.acquire(recipe.key)),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(manager.size(recipe.key)).toBe(0);
  });

  it('recycles a released worker and replaces it without reusing the handle', async () => {
    let now = 1_000;
    const { capability, recycled } = makeCapability(() => now);
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();
    await manager.prewarm(recipe, 1);
    const acquired = manager.acquire(recipe.key);
    expect(acquired).not.toBeNull();

    now = 2_000;
    await manager.release(acquired!);
    const replacement = manager.acquire(recipe.key);

    expect(recycled.map((handle) => handle.id)).toEqual(['worker-1']);
    expect(replacement?.id).toBe('worker-2');
    expect(replacement?.id).not.toBe(acquired?.id);
  });

  it('uses a fresh worker recipe when replacing a released worker', async () => {
    let now = 1_000;
    let nextWorkerId = 0;
    let nextRecipeId = 1;
    const usedRecipes: string[] = [];
    const recipeFor = (id: string): SharedBootRecipe =>
      makeRecipe({
        runnerProcessName: id,
        refresh: async () => recipeFor(`recipe-${++nextRecipeId}`),
      });
    const capability: WarmPoolCapable = {
      id: 'anthropic:claude-agent-sdk',
      prepare: async () => {
        throw new Error('not used');
      },
      prewarm: vi.fn(async (recipe) => {
        usedRecipes.push(recipe.runnerProcessName ?? '(missing)');
        return {
          id: `worker-${++nextWorkerId}`,
          key: recipe.key,
          bornAt: now,
          bound: false,
        };
      }),
      bind: async (): Promise<BoundRun> => {
        throw new Error('not used');
      },
      recycle: vi.fn(async () => undefined),
    };
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = recipeFor('recipe-1');
    await manager.prewarm(recipe, 1);
    const acquired = manager.acquire(recipe.key);
    expect(acquired).not.toBeNull();

    now = 2_000;
    await manager.release(acquired!);

    expect(usedRecipes).toEqual(['recipe-1', 'recipe-2']);
  });

  it('retries a failed release replacement with backoff so the pool recovers', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    let nextWorkerId = 0;
    let prewarmCalls = 0;
    const recycled: WarmWorkerHandle[] = [];
    const capability: WarmPoolCapable = {
      id: 'anthropic:claude-agent-sdk',
      prepare: async () => {
        throw new Error('not used');
      },
      prewarm: vi.fn(async (recipe) => {
        prewarmCalls += 1;
        if (prewarmCalls === 2) throw new Error('replacement failed');
        return {
          id: `worker-${++nextWorkerId}`,
          key: recipe.key,
          bornAt: now,
          bound: false,
        };
      }),
      bind: async (): Promise<BoundRun> => {
        throw new Error('not used');
      },
      recycle: vi.fn(async (handle) => {
        recycled.push(handle);
      }),
    };
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      replacementBackoffMs: 50,
    });
    const recipe = makeRecipe();
    await manager.prewarm(recipe, 1);
    const acquired = manager.acquire(recipe.key);
    expect(acquired).not.toBeNull();

    now = 2_000;
    await expect(manager.release(acquired!)).resolves.toBeUndefined();
    expect(recycled.map((handle) => handle.id)).toEqual(['worker-1']);
    expect(manager.size(recipe.key)).toBe(0);
    expect(capability.prewarm).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(49);
    expect(manager.size(recipe.key)).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(manager.size(recipe.key)).toBe(1);
    expect(manager.acquire(recipe.key)?.id).toBe('worker-2');
  });

  it('bounds concurrent prewarm boots', async () => {
    let now = 1_000;
    let nextWorkerId = 0;
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const capability: WarmPoolCapable = {
      id: 'anthropic:claude-agent-sdk',
      prepare: async () => {
        throw new Error('not used');
      },
      prewarm: vi.fn(async (recipe) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return {
          id: `worker-${++nextWorkerId}`,
          key: recipe.key,
          bornAt: now,
          bound: false,
        };
      }),
      bind: async (): Promise<BoundRun> => {
        throw new Error('not used');
      },
      recycle: vi.fn(async () => undefined),
    };
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      maxConcurrentPrewarm: 1,
    });
    const recipe = makeRecipe();

    const prewarm = manager.prewarm(recipe, 3);
    await Promise.resolve();
    expect(capability.prewarm).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(capability.prewarm).toHaveBeenCalledTimes(2));

    releases.shift()?.();
    await vi.waitFor(() => expect(capability.prewarm).toHaveBeenCalledTimes(3));

    releases.shift()?.();
    await prewarm;
    expect(maxActive).toBe(1);
    expect(manager.size(recipe.key)).toBe(3);
  });

  it('keeps successful workers when one target-size prewarm boot fails', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    let nextWorkerId = 0;
    let prewarmCalls = 0;
    const capability: WarmPoolCapable = {
      id: 'anthropic:claude-agent-sdk',
      prepare: async () => {
        throw new Error('not used');
      },
      prewarm: vi.fn(async (recipe) => {
        prewarmCalls += 1;
        if (prewarmCalls === 1) throw new Error('worker startup timed out');
        return {
          id: `worker-${++nextWorkerId}`,
          key: recipe.key,
          bornAt: now,
          bound: false,
        };
      }),
      bind: async (): Promise<BoundRun> => {
        throw new Error('not used');
      },
      recycle: vi.fn(async () => undefined),
    };
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      replacementBackoffMs: 50,
    });
    const recipe = makeRecipe();

    await expect(manager.prewarm(recipe, 3)).resolves.toBeUndefined();

    expect(manager.size(recipe.key)).toBe(2);
    expect(capability.prewarm).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(50);

    expect(manager.size(recipe.key)).toBe(3);
    expect(capability.prewarm).toHaveBeenCalledTimes(4);
  });

  it('waits for cache prewarm before marking a worker idle', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    let finishCachePrewarm: (() => void) | undefined;
    capability.prewarmCaches = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishCachePrewarm = resolve;
        }),
    );
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();

    const prewarm = manager.prewarm(recipe, 1);
    await vi.waitFor(() => expect(capability.prewarmCaches).toHaveBeenCalled());

    expect(manager.inventory(recipe.key)).toMatchObject({
      genericAvailable: 0,
      genericStarting: 1,
    });

    finishCachePrewarm?.();
    await prewarm;

    expect(manager.inventory(recipe.key)).toMatchObject({
      genericAvailable: 1,
      genericStarting: 0,
    });
    expect(manager.acquire(recipe.key)?.cachePrewarm).toEqual({
      status: 'succeeded',
    });
  });

  it('reports cache prewarm status and shape buckets in inventory', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    capability.prewarmCaches = vi.fn(async () => ({ status: 'succeeded' }));
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();

    await manager.prewarm(recipe, 1);

    expect(manager.inventory(recipe.key)).toMatchObject({
      cachePrewarm: {
        pending: 0,
        succeeded: 1,
        skipped: 0,
        failed: 0,
      },
      cacheShapes: [
        {
          cacheShapeKey: cacheShapeKeyOf(recipe),
          status: 'succeeded',
          workers: 1,
        },
      ],
    });
  });

  it('records failed cache prewarm without discarding the worker', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    capability.prewarmCaches = vi.fn(async () => {
      throw new Error('provider quota exhausted');
    });
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();

    await manager.prewarm(recipe, 1);

    const handle = manager.acquire(recipe.key);
    expect(handle?.cachePrewarm).toEqual({
      status: 'failed',
      reason: 'provider quota exhausted',
    });
  });

  it('deduplicates provider cache prewarm by cache shape across workers', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    capability.prewarmCaches = vi.fn(async () => ({ status: 'succeeded' }));
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();

    await manager.prewarm(recipe, 3);

    expect(capability.prewarm).toHaveBeenCalledTimes(3);
    expect(capability.prewarmCaches).toHaveBeenCalledTimes(1);
    expect(manager.inventory(recipe.key)).toMatchObject({
      cachePrewarm: {
        pending: 0,
        succeeded: 3,
        skipped: 0,
        failed: 0,
      },
      cacheShapes: [
        {
          cacheShapeKey: cacheShapeKeyOf(recipe),
          status: 'succeeded',
          workers: 3,
        },
      ],
    });
  });

  it('refreshes provider cache prewarm once the shape ttl expires', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    capability.prewarmCaches = vi.fn(async () => ({ status: 'succeeded' }));
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      cachePrewarmTtlMs: 1_000,
    });
    const recipe = makeRecipe();

    await manager.prewarm(recipe, 1);
    expect(capability.prewarmCaches).toHaveBeenCalledTimes(1);

    await manager.release(manager.acquire(recipe.key)!);
    expect(capability.prewarmCaches).toHaveBeenCalledTimes(1);

    now += 1_001;
    await manager.release(manager.acquire(recipe.key)!);

    expect(capability.prewarmCaches).toHaveBeenCalledTimes(2);
  });

  it('refreshes provider cache prewarm proactively after the shape ttl', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    capability.prewarmCaches = vi.fn(async () => ({ status: 'succeeded' }));
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      cachePrewarmTtlMs: 1_000,
    });
    const recipe = makeRecipe();

    await manager.prewarm(recipe, 3);
    expect(capability.prewarmCaches).toHaveBeenCalledTimes(1);

    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(capability.prewarmCaches).toHaveBeenCalledTimes(2);
    expect(manager.inventory(recipe.key)).toMatchObject({
      cachePrewarm: {
        pending: 0,
        succeeded: 3,
        skipped: 0,
        failed: 0,
      },
      cacheShapes: [
        {
          cacheShapeKey: cacheShapeKeyOf(recipe),
          status: 'succeeded',
          workers: 3,
        },
      ],
    });
  });

  it('skips provider cache prewarm when disabled by runtime config', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    capability.prewarmCaches = vi.fn(async () => ({ status: 'succeeded' }));
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      cachePrewarmEnabled: false,
    });
    const recipe = makeRecipe();

    await manager.prewarm(recipe, 1);

    expect(capability.prewarmCaches).not.toHaveBeenCalled();
    expect(manager.acquire(recipe.key)?.cachePrewarm).toEqual({
      status: 'skipped',
      reason: 'disabled',
    });
  });

  it('bounds concurrent cache prewarm probes across cache shapes', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    capability.prewarmCaches = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve();
          });
        }),
    );
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      maxConcurrentCachePrewarm: 1,
    });
    const recipes = [
      makeRecipe({ systemPromptVersion: 'prompt-v1' }),
      makeRecipe({ systemPromptVersion: 'prompt-v2' }),
      makeRecipe({ systemPromptVersion: 'prompt-v3' }),
    ];

    const prewarm = Promise.all(
      recipes.map((recipe) => manager.prewarm(recipe, 1)),
    );
    await vi.waitFor(() => expect(capability.prewarm).toHaveBeenCalledTimes(3));
    expect(capability.prewarmCaches).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() =>
      expect(capability.prewarmCaches).toHaveBeenCalledTimes(2),
    );

    releases.shift()?.();
    await vi.waitFor(() =>
      expect(capability.prewarmCaches).toHaveBeenCalledTimes(3),
    );

    releases.shift()?.();
    await prewarm;
    expect(maxActive).toBe(1);
    for (const recipe of recipes) {
      expect(manager.size(recipe.key)).toBe(1);
    }
  });

  it('evicts idle workers older than the ttl and replenishes the pool', async () => {
    let now = 1_000;
    const { capability, recycled } = makeCapability(() => now);
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();
    await manager.prewarm(recipe, 2);

    now = 2_001;
    await manager.evictIdle(1_000);

    expect(recycled.map((handle) => handle.id)).toEqual([
      'worker-1',
      'worker-2',
    ]);
    expect(manager.size(recipe.key)).toBe(2);
    expect(manager.acquire(recipe.key)?.id).toBe('worker-3');
    expect(manager.acquire(recipe.key)?.id).toBe('worker-4');
  });

  it('shutdown recycles all idle warm workers', async () => {
    let now = 1_000;
    const { capability, recycled } = makeCapability(() => now);
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();
    await manager.prewarm(recipe, 2);

    await manager.shutdown();

    expect(recycled.map((handle) => handle.id)).toEqual([
      'worker-1',
      'worker-2',
    ]);
    expect(manager.size(recipe.key)).toBe(0);
  });

  it('shutdown recycles a worker that finishes booting after shutdown starts', async () => {
    let now = 1_000;
    let releasePrewarm: (() => void) | undefined;
    const recycled: WarmWorkerHandle[] = [];
    const capability: WarmPoolCapable = {
      id: 'anthropic:claude-agent-sdk',
      prepare: async () => {
        throw new Error('not used');
      },
      prewarm: vi.fn(async (recipe) => {
        await new Promise<void>((resolve) => {
          releasePrewarm = resolve;
        });
        return {
          id: 'worker-1',
          key: recipe.key,
          bornAt: now,
          bound: false,
        };
      }),
      bind: async (): Promise<BoundRun> => {
        throw new Error('not used');
      },
      recycle: vi.fn(async (handle) => {
        recycled.push(handle);
      }),
    };
    const manager = new WarmPoolManager({ capability, clock: () => now });
    const recipe = makeRecipe();

    const prewarm = manager.prewarm(recipe, 1);
    await vi.waitFor(() => expect(capability.prewarm).toHaveBeenCalledTimes(1));
    await manager.shutdown();
    releasePrewarm?.();
    await prewarm;

    expect(recycled.map((handle) => handle.id)).toEqual(['worker-1']);
    expect(manager.size(recipe.key)).toBe(0);
  });

  it('reaps previously tagged warm workers through the injected boot-time reaper', async () => {
    let now = 1_000;
    const { capability } = makeCapability(() => now);
    const reap = vi.fn(async () => 2);
    const manager = new WarmPoolManager({
      capability,
      clock: () => now,
      orphanMarker: 'gantry-warm-pool:test',
      orphanReaper: { reap },
    });

    await expect(manager.reapOrphans()).resolves.toBe(2);

    expect(reap).toHaveBeenCalledWith('gantry-warm-pool:test');
  });
});
