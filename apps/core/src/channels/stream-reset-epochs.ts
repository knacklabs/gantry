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

  bumpMatching(keys: Iterable<string>, prefix: string): void {
    for (const key of keys) if (key.startsWith(prefix)) this.bump(key);
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
