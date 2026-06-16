import type {
  SharedBootRecipe,
  WarmPoolCapable,
  WarmPoolKey,
  WarmWorkerHandle,
} from '../application/agent-execution/warm-pool-capable.js';

interface IdleWorker {
  readonly handle: WarmWorkerHandle;
  readonly idleSince: number;
}

interface WarmPoolEntry {
  recipe: SharedBootRecipe;
  targetSize: number;
  idle: IdleWorker[];
  prewarming: number;
  bootAttempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export const WARM_POOL_ORPHAN_MARKER = 'gantry-warm-pool-worker';

export interface WarmPoolOrphanReaper {
  reap(marker: string): Promise<number>;
}

export interface WarmPoolManagerOptions {
  capability: WarmPoolCapable;
  clock?: () => number;
  maxConcurrentPrewarm?: number;
  replacementBackoffMs?: number;
  orphanMarker?: string;
  orphanReaper?: WarmPoolOrphanReaper;
}

export class WarmPoolManager {
  private readonly capability: WarmPoolCapable;
  private readonly clock: () => number;
  private readonly maxConcurrentPrewarm: number;
  private readonly replacementBackoffMs: number;
  private readonly orphanMarker: string;
  private readonly orphanReaper?: WarmPoolOrphanReaper;
  private readonly entries = new Map<WarmPoolKey, WarmPoolEntry>();
  private activePrewarms = 0;
  private readonly prewarmWaiters: Array<() => void> = [];
  private shuttingDown = false;

  constructor(options: WarmPoolManagerOptions) {
    this.capability = options.capability;
    this.clock = options.clock ?? Date.now;
    this.maxConcurrentPrewarm =
      options.maxConcurrentPrewarm ?? Number.POSITIVE_INFINITY;
    this.replacementBackoffMs = options.replacementBackoffMs ?? 1_000;
    this.orphanMarker = options.orphanMarker ?? WARM_POOL_ORPHAN_MARKER;
    this.orphanReaper = options.orphanReaper;
  }

  async prewarm(recipe: SharedBootRecipe, count: number): Promise<void> {
    if (this.shuttingDown) return;
    if (count <= 0) return;
    const entry = this.entryFor(recipe);
    entry.targetSize = Math.max(entry.targetSize, count);
    await this.replenish(recipe.key);
  }

  acquire(key: WarmPoolKey): WarmWorkerHandle | null {
    const entry = this.entries.get(key);
    const worker = entry?.idle.shift();
    if (!worker) return null;
    return worker.handle;
  }

  async release(handle: WarmWorkerHandle): Promise<void> {
    const entry = this.entries.get(handle.key);
    await this.capability.recycle(handle);
    if (entry) await this.replenishOrSchedule(handle.key);
  }

  async replenish(key: WarmPoolKey): Promise<void> {
    if (this.shuttingDown) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    const missing = entry.targetSize - entry.idle.length - entry.prewarming;
    if (missing <= 0) return;
    await this.bootMany(entry, missing);
  }

  async healthCheck(key?: WarmPoolKey): Promise<void> {
    if (!this.capability.healthCheck) return;
    const entries =
      key === undefined
        ? Array.from(this.entries.values())
        : [this.entries.get(key)].filter(
            (entry): entry is WarmPoolEntry => entry !== undefined,
          );
    for (const entry of entries) {
      const healthy: IdleWorker[] = [];
      for (const worker of entry.idle) {
        if (await this.capability.healthCheck(worker.handle)) {
          healthy.push(worker);
          continue;
        }
        await this.capability.recycle(worker.handle);
      }
      entry.idle = healthy;
      await this.replenishOrSchedule(entry.recipe.key);
    }
  }

  async evictIdle(ttlMs: number): Promise<void> {
    const now = this.clock();
    for (const entry of this.entries.values()) {
      const retained: IdleWorker[] = [];
      for (const worker of entry.idle) {
        if (now - worker.idleSince <= ttlMs) {
          retained.push(worker);
          continue;
        }
        await this.capability.recycle(worker.handle);
      }
      entry.idle = retained;
      await this.replenishOrSchedule(entry.recipe.key);
    }
  }

  size(key: WarmPoolKey): number {
    return this.entries.get(key)?.idle.length ?? 0;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const entries = Array.from(this.entries.values());
    for (const entry of entries) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
    }
    const idleWorkers = entries.flatMap((entry) => entry.idle);
    this.entries.clear();
    await Promise.all(
      idleWorkers.map((worker) => this.capability.recycle(worker.handle)),
    );
  }

  async reapOrphans(): Promise<number> {
    if (!this.orphanReaper) return 0;
    return this.orphanReaper.reap(this.orphanMarker);
  }

  private entryFor(recipe: SharedBootRecipe): WarmPoolEntry {
    let entry = this.entries.get(recipe.key);
    if (!entry) {
      entry = {
        recipe,
        targetSize: 0,
        idle: [],
        prewarming: 0,
        bootAttempts: 0,
      };
      this.entries.set(recipe.key, entry);
      return entry;
    }
    entry.recipe = recipe;
    if (entry.idle.length === 0 && entry.prewarming === 0) {
      entry.bootAttempts = 0;
    }
    return entry;
  }

  private async bootMany(entry: WarmPoolEntry, count: number): Promise<void> {
    await Promise.all(
      Array.from({ length: count }, async () => this.bootOne(entry)),
    );
  }

  private async bootOne(entry: WarmPoolEntry): Promise<void> {
    entry.prewarming += 1;
    try {
      const handle = await this.withPrewarmSlot(async () => {
        const recipe = await this.recipeForBoot(entry);
        return this.capability.prewarm(recipe);
      });
      if (!handle) return;
      handle.bound = false;
      if (this.shuttingDown || this.entries.get(entry.recipe.key) !== entry) {
        await this.capability.recycle(handle);
        return;
      }
      entry.idle.push({ handle, idleSince: this.clock() });
    } finally {
      entry.prewarming -= 1;
    }
  }

  private async recipeForBoot(entry: WarmPoolEntry): Promise<SharedBootRecipe> {
    const useSeedRecipe = entry.bootAttempts === 0;
    entry.bootAttempts += 1;
    if (useSeedRecipe || !entry.recipe.refresh) return entry.recipe;
    return entry.recipe.refresh();
  }

  private async replenishOrSchedule(key: WarmPoolKey): Promise<void> {
    try {
      await this.replenish(key);
    } catch {
      this.scheduleReplenish(key);
    }
  }

  private scheduleReplenish(key: WarmPoolKey): void {
    if (this.shuttingDown) return;
    const entry = this.entries.get(key);
    if (!entry || entry.retryTimer) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      void this.replenish(key).catch(() => this.scheduleReplenish(key));
    }, this.replacementBackoffMs);
  }

  private async withPrewarmSlot<T>(
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    if (this.activePrewarms >= this.maxConcurrentPrewarm) {
      await new Promise<void>((resolve) => this.prewarmWaiters.push(resolve));
    }
    if (this.shuttingDown) return undefined;
    this.activePrewarms += 1;
    try {
      return await operation();
    } finally {
      this.activePrewarms -= 1;
      this.prewarmWaiters.shift()?.();
    }
  }
}
