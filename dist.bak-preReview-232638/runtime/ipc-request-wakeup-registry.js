import fs from 'fs';
import { isPendingIpcJsonFile } from './ipc-filesystem.js';
const DEFAULT_WATCHED_REQUEST_LANES = [
    'messages',
    'tasks',
    'memory-requests',
    'browser-requests',
    'permission-requests',
    'permission-cancellations',
    'question-cancellations',
    'rich-interactions',
    'user-questions',
];
export class IpcRequestWakeupRegistry {
    input;
    lanes;
    onWatchError;
    watch;
    watchers = new Map();
    failedWatchKeys = new Set();
    constructor(input) {
        this.input = input;
        this.lanes = input.deps?.lanes ?? DEFAULT_WATCHED_REQUEST_LANES;
        this.onWatchError = input.deps?.onWatchError;
        this.watch = input.deps?.watch ?? fs.watch;
    }
    reconcile(workspaceFolders) {
        const desiredKeys = new Set();
        for (const workspaceFolder of workspaceFolders) {
            for (const lane of this.lanes) {
                if (!this.input.runnerControlPort.isTrustedRequestDir(workspaceFolder, lane)) {
                    continue;
                }
                const key = watchKey(workspaceFolder, lane);
                desiredKeys.add(key);
                if (!this.watchers.has(key)) {
                    this.startWatcher({ workspaceFolder, lane, key });
                }
            }
        }
        for (const key of Array.from(this.watchers.keys())) {
            if (desiredKeys.has(key))
                continue;
            this.stopWatcher(key);
        }
    }
    stop() {
        for (const key of Array.from(this.watchers.keys())) {
            this.stopWatcher(key);
        }
        this.failedWatchKeys.clear();
    }
    startWatcher(input) {
        const { workspaceFolder, lane, key } = input;
        const dir = this.input.runnerControlPort.requestDir(workspaceFolder, lane);
        try {
            const watcher = this.watch(dir, { persistent: false }, (_eventType, filename) => {
                const wakeup = classifyIpcWakeup(filename);
                if (wakeup === 'ignored')
                    return;
                if (wakeup === 'specific') {
                    this.input.trigger({ workspaceFolder, lane });
                }
                else {
                    this.input.trigger();
                }
            });
            watcher.unref?.();
            watcher.on?.('error', (error) => {
                this.stopWatcher(key);
                this.reportWatchError({ workspaceFolder, lane, key, error });
                this.input.trigger();
            });
            this.watchers.set(key, watcher);
            this.failedWatchKeys.delete(key);
        }
        catch (error) {
            this.reportWatchError({ workspaceFolder, lane, key, error });
        }
    }
    stopWatcher(key) {
        const watcher = this.watchers.get(key);
        if (!watcher)
            return;
        this.watchers.delete(key);
        try {
            watcher.close();
        }
        catch {
            // Best effort shutdown; fallback polling remains authoritative.
        }
    }
    reportWatchError(input) {
        if (this.failedWatchKeys.has(input.key))
            return;
        this.failedWatchKeys.add(input.key);
        this.onWatchError?.({
            workspaceFolder: input.workspaceFolder,
            lane: input.lane,
            error: input.error,
        });
    }
}
function watchKey(workspaceFolder, lane) {
    return `${workspaceFolder}\0${lane}`;
}
function classifyIpcWakeup(filename) {
    if (!filename)
        return 'unknown';
    const name = Buffer.isBuffer(filename)
        ? filename.toString('utf-8')
        : filename;
    return isPendingIpcJsonFile(name) ? 'specific' : 'ignored';
}
