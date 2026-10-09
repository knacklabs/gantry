export class StreamResetEpochs {
  private readonly byKey = new Map<string, number>();
  private next = 0;

  current(key: string): number {
    const current = this.byKey.get(key);
    if (current !== undefined) return current;
    const created = ++this.next;
    this.byKey.set(key, created);
    return created;
  }

  guard<T>(
    key: string,
    states: ReadonlyMap<string, T>,
  ): (state: T, allowCompleted?: boolean) => boolean {
    const epoch = this.current(key);
    return (state, allowCompleted = false) => {
      const current = states.get(key);
      return (
        this.isCurrent(key, epoch) &&
        (current === state || (allowCompleted && current === undefined))
      );
    };
  }

  bump(key: string): void {
    this.byKey.set(key, ++this.next);
  }

  isCurrent(key: string, epoch: number): boolean {
    return this.byKey.get(key) === epoch;
  }

  prune(key: string): void {
    this.byKey.delete(key);
  }

  deleteState<T>(key: string, states: Map<string, T>): void {
    states.delete(key);
    this.prune(key);
  }

  clear(): void {
    this.byKey.clear();
  }
}

// Generation guard per stream key (chat + thread): a newer generation replaces
// only that key's stream; older or finished generations on the key are refused.
// ponytail: entries live until disconnect; prune finished keys if threads ever number in the millions.
export class StreamGenerationFence {
  private readonly latest = new Map<string, number>();
  private readonly done = new Map<string, number>();

  accept(
    key: string,
    generation: number | undefined,
    dropStream: () => void,
  ): boolean {
    if (generation === undefined) return true;
    if (this.isDone(key, generation)) return false;
    const latest = this.latest.get(key);
    if (latest !== undefined && generation < latest) return false;
    if (latest !== undefined && generation > latest) dropStream();
    this.latest.set(key, generation);
    return true;
  }

  isCurrent(key: string, generation: number | undefined): boolean {
    if (generation === undefined) return true;
    const latest = this.latest.get(key);
    return (
      !this.isDone(key, generation) &&
      (latest === undefined || generation === latest)
    );
  }

  markDone(key: string, generation: number | undefined): void {
    if (generation === undefined || this.isDone(key, generation)) return;
    this.done.set(key, generation);
  }

  clear(): void {
    this.latest.clear();
    this.done.clear();
  }

  private isDone(key: string, generation: number): boolean {
    const done = this.done.get(key);
    return done !== undefined && generation <= done;
  }
}
