import type {
  SharedBootRecipe,
  WarmPoolCapable,
  WarmPoolKey,
  WarmWorkerCachePrewarmResult,
  WarmWorkerHandle,
} from '../application/agent-execution/warm-pool-capable.js';
import { DEFAULT_WARM_POOL_MAX_BOUND_WORKERS } from '../config/settings/runtime-settings-defaults.js';
import type {
  WorkerInventoryCachePrewarmSnapshot,
  WorkerInventoryCachePrewarmStatus,
  WorkerInventoryCacheShapeSnapshot,
} from './worker-inventory-snapshot.js';

interface IdleWorker {
  readonly handle: WarmWorkerHandle;
  readonly idleSince: number;
}

interface WarmPoolEntry {
  recipe: SharedBootRecipe;
  targetSize: number;
  idle: IdleWorker[];
  active: Map<string, WarmWorkerHandle>;
  prewarming: number;
  bootAttempts: number;
  replenishPromise?: Promise<void>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

interface CachePrewarmRecord {
  result: WarmWorkerCachePrewarmResult;
  refreshedAt: number;
}

const DEFAULT_CACHE_PREWARM_TTL_MS = 45 * 60 * 1000;

export const WARM_POOL_ORPHAN_MARKER = 'gantry-warm-pool-worker';

export interface WarmPoolInventorySnapshot {
  availableTarget: number;
  genericAvailable: number;
  genericStarting: number;
  boundActive: number;
  boundIdle: number;
  boundDraining: number;
  maxBoundWorkers: number;
  cachePrewarm: WorkerInventoryCachePrewarmSnapshot;
  cacheShapes: WorkerInventoryCacheShapeSnapshot[];
}

export interface WarmPoolOrphanReaper {
  reap(marker: string): Promise<number>;
}

export interface WarmPoolManagerOptions {
  capability: WarmPoolCapable;
  clock?: () => number;
  maxConcurrentPrewarm?: number;
  cachePrewarmEnabled?: boolean;
  maxConcurrentCachePrewarm?: number;
  cachePrewarmTtlMs?: number;
  maxBoundWorkers?: number;
  replacementBackoffMs?: number;
  orphanMarker?: string;
  orphanReaper?: WarmPoolOrphanReaper;
}

export class WarmPoolManager {
  private readonly capability: WarmPoolCapable;
  private readonly clock: () => number;
  private readonly maxConcurrentPrewarm: number;
  private readonly cachePrewarmEnabled: boolean;
  private readonly maxConcurrentCachePrewarm: number;
  private readonly cachePrewarmTtlMs: number;
  private readonly maxBoundWorkers: number;
  private readonly replacementBackoffMs: number;
  private readonly orphanMarker: string;
  private readonly orphanReaper?: WarmPoolOrphanReaper;
  private readonly entries = new Map<WarmPoolKey, WarmPoolEntry>();
  private activePrewarms = 0;
  private readonly prewarmWaiters: Array<() => void> = [];
  private activeCachePrewarms = 0;
  private readonly cachePrewarmWaiters: Array<() => void> = [];
  private readonly cachePrewarmByShape = new Map<
    string,
    CachePrewarmRecord
  >();
  private readonly cachePrewarmInFlightByShape = new Map<
    string,
    Promise<WarmWorkerCachePrewarmResult>
  >();
  private readonly cachePrewarmRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private shuttingDown = false;

  constructor(options: WarmPoolManagerOptions) {
    this.capability = options.capability;
    this.clock = options.clock ?? Date.now;
    this.maxConcurrentPrewarm =
      options.maxConcurrentPrewarm ?? Number.POSITIVE_INFINITY;
    this.cachePrewarmEnabled = options.cachePrewarmEnabled ?? true;
    this.maxConcurrentCachePrewarm = options.maxConcurrentCachePrewarm ?? 1;
    this.cachePrewarmTtlMs =
      options.cachePrewarmTtlMs ?? DEFAULT_CACHE_PREWARM_TTL_MS;
    this.maxBoundWorkers =
      options.maxBoundWorkers ?? DEFAULT_WARM_POOL_MAX_BOUND_WORKERS;
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
    if (this.boundActiveCount() >= this.maxBoundWorkers) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    const worker = entry.idle.shift();
    if (!worker) return null;
    entry.active.set(worker.handle.id, worker.handle);
    void this.replenishOrSchedule(key);
    return worker.handle;
  }

  async release(handle: WarmWorkerHandle): Promise<void> {
    const entry = this.entries.get(handle.key);
    entry?.active.delete(handle.id);
    await this.capability.recycle(handle);
    if (entry) await this.replenishOrSchedule(handle.key);
  }

  async replenish(key: WarmPoolKey): Promise<void> {
    if (this.shuttingDown) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.replenishPromise) return entry.replenishPromise;
    entry.replenishPromise = this.replenishEntry(entry);
    try {
      await entry.replenishPromise;
    } finally {
      entry.replenishPromise = undefined;
    }
  }

  private async replenishEntry(entry: WarmPoolEntry): Promise<void> {
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

  inventory(key?: WarmPoolKey): WarmPoolInventorySnapshot {
    const entries =
      key === undefined
        ? Array.from(this.entries.values())
        : [this.entries.get(key)].filter(
            (entry): entry is WarmPoolEntry => entry !== undefined,
          );
    return entries.reduce<WarmPoolInventorySnapshot>((snapshot, entry) => {
      const handles = [
        ...entry.idle.map((worker) => worker.handle),
        ...entry.active.values(),
      ];
      return {
        availableTarget: snapshot.availableTarget + entry.targetSize,
        genericAvailable: snapshot.genericAvailable + entry.idle.length,
        genericStarting: snapshot.genericStarting + entry.prewarming,
        boundActive: snapshot.boundActive + entry.active.size,
        boundIdle: snapshot.boundIdle,
        boundDraining: snapshot.boundDraining,
        maxBoundWorkers: this.maxBoundWorkers,
        cachePrewarm: addCachePrewarmCounts(
          snapshot.cachePrewarm,
          cachePrewarmCountsFor(handles),
        ),
        cacheShapes: addCacheShapeBuckets(
          snapshot.cacheShapes,
          cacheShapeBucketsFor(handles),
        ),
      };
    }, emptyInventorySnapshot(this.maxBoundWorkers));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const entries = Array.from(this.entries.values());
    for (const entry of entries) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
    }
    for (const timer of this.cachePrewarmRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.cachePrewarmRefreshTimers.clear();
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
        active: new Map(),
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
    const results = await Promise.allSettled(
      Array.from({ length: count }, async () => this.bootOne(entry)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length === 0) return;
    if (failures.length === count) throw failures[0]!.reason;
    this.scheduleReplenish(entry.recipe.key);
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
      await this.prepareCache(handle);
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

  private boundActiveCount(): number {
    return Array.from(this.entries.values()).reduce(
      (count, entry) => count + entry.active.size,
      0,
    );
  }

  private async prepareCache(handle: WarmWorkerHandle): Promise<void> {
    if (!this.cachePrewarmEnabled) {
      handle.cachePrewarm = {
        status: 'skipped',
        reason: 'disabled',
      };
      return;
    }
    if (!this.capability.prewarmCaches) {
      handle.cachePrewarm = {
        status: 'skipped',
        reason: 'capability_unavailable',
      };
      return;
    }
    if (!handle.cacheShapeKey) {
      handle.cachePrewarm = {
        status: 'skipped',
        reason: 'missing_cache_shape_key',
      };
      return;
    }
    handle.cachePrewarm = await this.ensureShapeCachePrewarm(handle);
  }

  private async ensureShapeCachePrewarm(
    handle: WarmWorkerHandle,
  ): Promise<WarmWorkerCachePrewarmResult> {
    const shapeKey = handle.cacheShapeKey;
    if (!shapeKey) {
      return { status: 'skipped', reason: 'missing_cache_shape_key' };
    }
    const cached = this.cachePrewarmByShape.get(shapeKey);
    if (cached && this.isFreshCachePrewarm(cached)) {
      return cached.result;
    }
    return this.runShapeCachePrewarm(shapeKey, handle);
  }

  private isFreshCachePrewarm(record: CachePrewarmRecord): boolean {
    return this.clock() - record.refreshedAt <= this.cachePrewarmTtlMs;
  }

  private scheduleShapeCachePrewarmRefresh(shapeKey: string): void {
    if (this.shuttingDown) return;
    const previous = this.cachePrewarmRefreshTimers.get(shapeKey);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.cachePrewarmRefreshTimers.delete(shapeKey);
      void this.refreshShapeCachePrewarm(shapeKey);
    }, this.cachePrewarmTtlMs);
    timer.unref?.();
    this.cachePrewarmRefreshTimers.set(shapeKey, timer);
  }

  private async refreshShapeCachePrewarm(shapeKey: string): Promise<void> {
    if (this.shuttingDown) return;
    const handle = this.findCachePrewarmHandle(shapeKey);
    if (!handle) return;
    const result = await this.runShapeCachePrewarm(shapeKey, handle);
    this.applyCachePrewarmResultToShape(shapeKey, result);
    if (result.status !== 'succeeded' && !this.shuttingDown) {
      this.scheduleShapeCachePrewarmRefresh(shapeKey);
    }
  }

  private findCachePrewarmHandle(
    shapeKey: string,
  ): WarmWorkerHandle | undefined {
    for (const entry of this.entries.values()) {
      for (const worker of entry.idle) {
        if (worker.handle.cacheShapeKey === shapeKey) return worker.handle;
      }
      for (const handle of entry.active.values()) {
        if (handle.cacheShapeKey === shapeKey) return handle;
      }
    }
    return undefined;
  }

  private applyCachePrewarmResultToShape(
    shapeKey: string,
    result: WarmWorkerCachePrewarmResult,
  ): void {
    for (const entry of this.entries.values()) {
      for (const worker of entry.idle) {
        if (worker.handle.cacheShapeKey === shapeKey) {
          worker.handle.cachePrewarm = result;
        }
      }
      for (const handle of entry.active.values()) {
        if (handle.cacheShapeKey === shapeKey) {
          handle.cachePrewarm = result;
        }
      }
    }
  }

  private async runShapeCachePrewarm(
    shapeKey: string,
    handle: WarmWorkerHandle,
  ): Promise<WarmWorkerCachePrewarmResult> {
    const inFlight = this.cachePrewarmInFlightByShape.get(shapeKey);
    if (inFlight) return inFlight;

    const prewarm = this.withCachePrewarmSlot(async () => {
      try {
        const result = normalizeCachePrewarmResult(
          await this.capability.prewarmCaches?.(handle),
        );
        if (result.status === 'succeeded') {
          this.cachePrewarmByShape.set(shapeKey, {
            result,
            refreshedAt: this.clock(),
          });
          this.scheduleShapeCachePrewarmRefresh(shapeKey);
        }
        return result;
      } catch (error) {
        return {
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        } satisfies WarmWorkerCachePrewarmResult;
      }
    }).then(
      (result): WarmWorkerCachePrewarmResult =>
        result ?? { status: 'skipped', reason: 'shutdown' },
    );

    this.cachePrewarmInFlightByShape.set(shapeKey, prewarm);
    try {
      return await prewarm;
    } finally {
      this.cachePrewarmInFlightByShape.delete(shapeKey);
    }
  }

  private async withCachePrewarmSlot<T>(
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    if (this.activeCachePrewarms >= this.maxConcurrentCachePrewarm) {
      await new Promise<void>((resolve) =>
        this.cachePrewarmWaiters.push(resolve),
      );
    }
    if (this.shuttingDown) return undefined;
    this.activeCachePrewarms += 1;
    try {
      return await operation();
    } finally {
      this.activeCachePrewarms -= 1;
      this.cachePrewarmWaiters.shift()?.();
    }
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

function normalizeCachePrewarmResult(
  result: WarmWorkerCachePrewarmResult | void,
): WarmWorkerCachePrewarmResult {
  return result ?? { status: 'succeeded' };
}

function emptyCachePrewarmCounts(): WorkerInventoryCachePrewarmSnapshot {
  return {
    pending: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
  };
}

function emptyInventorySnapshot(
  maxBoundWorkers: number,
): WarmPoolInventorySnapshot {
  return {
    availableTarget: 0,
    genericAvailable: 0,
    genericStarting: 0,
    boundActive: 0,
    boundIdle: 0,
    boundDraining: 0,
    maxBoundWorkers,
    cachePrewarm: emptyCachePrewarmCounts(),
    cacheShapes: [],
  };
}

function cachePrewarmStatusOf(
  handle: WarmWorkerHandle,
): WorkerInventoryCachePrewarmStatus {
  return handle.cachePrewarm?.status ?? 'pending';
}

function cachePrewarmCountsFor(
  handles: readonly WarmWorkerHandle[],
): WorkerInventoryCachePrewarmSnapshot {
  const counts = emptyCachePrewarmCounts();
  for (const handle of handles) {
    counts[cachePrewarmStatusOf(handle)] += 1;
  }
  return counts;
}

function addCachePrewarmCounts(
  current: WorkerInventoryCachePrewarmSnapshot,
  next: WorkerInventoryCachePrewarmSnapshot,
): WorkerInventoryCachePrewarmSnapshot {
  return {
    pending: current.pending + next.pending,
    succeeded: current.succeeded + next.succeeded,
    skipped: current.skipped + next.skipped,
    failed: current.failed + next.failed,
  };
}

function cacheShapeBucketsFor(
  handles: readonly WarmWorkerHandle[],
): WorkerInventoryCacheShapeSnapshot[] {
  const buckets = new Map<string, WorkerInventoryCacheShapeSnapshot>();
  for (const handle of handles) {
    if (!handle.cacheShapeKey) continue;
    const status = cachePrewarmStatusOf(handle);
    const key = `${handle.cacheShapeKey}\u0000${status}`;
    const existing = buckets.get(key);
    buckets.set(key, {
      cacheShapeKey: handle.cacheShapeKey,
      status,
      workers: (existing?.workers ?? 0) + 1,
    });
  }
  return sortedCacheShapeBuckets([...buckets.values()]);
}

function addCacheShapeBuckets(
  current: readonly WorkerInventoryCacheShapeSnapshot[],
  next: readonly WorkerInventoryCacheShapeSnapshot[],
): WorkerInventoryCacheShapeSnapshot[] {
  const buckets = new Map<string, WorkerInventoryCacheShapeSnapshot>();
  for (const shape of [...current, ...next]) {
    const key = `${shape.cacheShapeKey}\u0000${shape.status}`;
    const existing = buckets.get(key);
    buckets.set(key, {
      cacheShapeKey: shape.cacheShapeKey,
      status: shape.status,
      workers: (existing?.workers ?? 0) + shape.workers,
    });
  }
  return sortedCacheShapeBuckets([...buckets.values()]);
}

function sortedCacheShapeBuckets(
  shapes: WorkerInventoryCacheShapeSnapshot[],
): WorkerInventoryCacheShapeSnapshot[] {
  return shapes.sort(
    (left, right) =>
      left.cacheShapeKey.localeCompare(right.cacheShapeKey) ||
      left.status.localeCompare(right.status),
  );
}
