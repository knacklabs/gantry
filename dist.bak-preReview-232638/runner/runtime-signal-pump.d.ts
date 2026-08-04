import fs, { type FSWatcher } from 'fs';
type WatchFactory = (filename: string, options: {
    persistent: boolean;
}, listener: (eventType: string, filename: string | Buffer | null) => void) => FSWatcher;
export interface RuntimeSignalPump {
    trigger(): void;
    stop(): void;
}
export interface RuntimeSignalPumpDeps {
    clearTimeout?: typeof clearTimeout;
    mkdirSync?: typeof fs.mkdirSync;
    onWatchError?: (input: {
        dir: string;
        error: unknown;
    }) => void;
    setTimeout?: typeof setTimeout;
    watch?: WatchFactory;
}
export declare function startRuntimeSignalPump(input: {
    fallbackPollMs: number;
    healthyWatchFallbackPollMs?: number;
    inputDir: string;
    interactionBoundaryDir?: string;
    processSignals: () => boolean;
    deps?: RuntimeSignalPumpDeps;
}): RuntimeSignalPump;
export {};
