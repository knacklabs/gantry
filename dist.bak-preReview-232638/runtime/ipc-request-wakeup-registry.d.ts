import { type FSWatcher } from 'fs';
import type { RunnerControlPort, RunnerControlRequestLane } from './runner-control-port.js';
type WatchFactory = (filename: string, options: {
    persistent: boolean;
}, listener: (eventType: string, filename: string | Buffer | null) => void) => FSWatcher;
export interface IpcRequestWakeupRegistryDeps {
    lanes?: readonly RunnerControlRequestLane[];
    onWatchError?: (input: {
        workspaceFolder: string;
        lane: RunnerControlRequestLane;
        error: unknown;
    }) => void;
    watch?: WatchFactory;
}
export interface IpcRequestWakeupHint {
    workspaceFolder: string;
    lane: RunnerControlRequestLane;
}
export declare class IpcRequestWakeupRegistry {
    private readonly input;
    private readonly lanes;
    private readonly onWatchError;
    private readonly watch;
    private readonly watchers;
    private readonly failedWatchKeys;
    constructor(input: {
        runnerControlPort: Pick<RunnerControlPort, 'isTrustedRequestDir' | 'requestDir'>;
        trigger: (hint?: IpcRequestWakeupHint) => void;
        deps?: IpcRequestWakeupRegistryDeps;
    });
    reconcile(workspaceFolders: readonly string[]): void;
    stop(): void;
    private startWatcher;
    private stopWatcher;
    private reportWatchError;
}
export {};
