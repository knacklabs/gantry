export interface ProductSearchCacheOptions {
  ttlMs: number;
  refreshLeadMs: number;
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
  refreshAfterMs: number;
}

export class ProductSearchCache {
  private readonly ttlMs: number;
  private readonly refreshLeadMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: ProductSearchCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.refreshLeadMs = options.refreshLeadMs;
    this.now = options.now ?? Date.now;
  }

  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    const now = this.now();
    if (existing && now < existing.expiresAtMs) {
      if (now >= existing.refreshAfterMs) {
        void this.startLoad(key, loader).catch(() => undefined);
      }
      return existing.value as T;
    }

    return this.startLoad(key, loader);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private startLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const inFlight = this.inFlight.get(key);
    if (inFlight) return inFlight as Promise<T>;

    const promise = (async () => {
      const value = await loader();
      const loadedAtMs = this.now();
      this.entries.set(key, {
        value,
        expiresAtMs: loadedAtMs + this.ttlMs,
        refreshAfterMs:
          loadedAtMs + Math.max(0, this.ttlMs - this.refreshLeadMs),
      });
      return value;
    })();

    this.inFlight.set(key, promise);
    void promise.finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    return promise;
  }
}
