import fs from 'fs';
import path from 'path';
import { nowMs, sleep } from '../shared/time/datetime.js';
export const DEFAULT_IPC_RESPONSE_POLL_MS = 100;
export async function waitForIpcResponseFile(input) {
    const responsePath = input.responsePath;
    const responseDir = path.dirname(responsePath);
    const responseFile = path.basename(responsePath);
    const existsSync = input.deps?.existsSync ?? fs.existsSync;
    const now = input.deps?.nowMs ?? nowMs;
    const sleepFn = input.deps?.sleep ?? sleep;
    const watch = input.deps?.watch ?? fs.watch;
    const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_IPC_RESPONSE_POLL_MS;
    if (existsSync(responsePath))
        return true;
    let watcher;
    let wake;
    const notify = () => {
        const resolve = wake;
        wake = undefined;
        resolve?.();
    };
    try {
        watcher = watch(responseDir, { persistent: false }, (_eventType, filename) => {
            const observed = typeof filename === 'string'
                ? filename
                : Buffer.isBuffer(filename)
                    ? filename.toString('utf-8')
                    : '';
            if (!observed || observed === responseFile)
                notify();
        });
        watcher.unref?.();
    }
    catch {
        watcher = undefined;
    }
    try {
        while (now() < input.deadlineMs) {
            if (existsSync(responsePath))
                return true;
            const remainingMs = input.deadlineMs - now();
            if (remainingMs <= 0)
                break;
            const waitMs = Math.max(1, Math.min(pollIntervalMs, remainingMs));
            if (!watcher) {
                await sleepFn(waitMs);
                continue;
            }
            await Promise.race([
                new Promise((resolve) => {
                    wake = resolve;
                }),
                sleepFn(waitMs),
            ]);
            wake = undefined;
        }
        return existsSync(responsePath);
    }
    finally {
        wake = undefined;
        watcher?.close();
    }
}
