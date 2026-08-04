export declare class StreamResetEpochs {
    private readonly byKey;
    private next;
    current(key: string): number;
    guard<T>(key: string, states: ReadonlyMap<string, T>): (state: T, allowCompleted?: boolean) => boolean;
    bump(key: string): void;
    bumpMatching(keys: Iterable<string>, prefix: string): void;
    isCurrent(key: string, epoch: number): boolean;
    prune(key: string): void;
    deleteState<T>(key: string, states: Map<string, T>): void;
    clear(): void;
}
