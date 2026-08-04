import { type FSWatcher } from 'fs';
export declare const DEFAULT_IPC_RESPONSE_POLL_MS = 100;
type WatchFactory = (filename: string, options: {
    persistent: boolean;
}, listener: (eventType: string, filename: string | Buffer | null) => void) => FSWatcher;
export interface IpcResponseWaitDeps {
    existsSync?: (responsePath: string) => boolean;
    nowMs?: () => number;
    sleep?: (ms: number) => Promise<void>;
    watch?: WatchFactory;
}
export declare function waitForIpcResponseFile(input: {
    responsePath: string;
    deadlineMs: number;
    pollIntervalMs?: number;
    deps?: IpcResponseWaitDeps;
}): Promise<boolean>;
export {};
