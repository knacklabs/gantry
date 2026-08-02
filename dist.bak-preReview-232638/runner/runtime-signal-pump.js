import fs from 'fs';
import path from 'path';
export function startRuntimeSignalPump(input) {
    const setTimeoutFn = input.deps?.setTimeout ?? setTimeout;
    const clearTimeoutFn = input.deps?.clearTimeout ?? clearTimeout;
    const watch = input.deps?.watch ?? fs.watch;
    const mkdirSync = input.deps?.mkdirSync ?? fs.mkdirSync;
    const onWatchError = input.deps?.onWatchError;
    let running = true;
    let processing = false;
    let rerunAfterCurrentPass = false;
    let rerunAfterCurrentPassSource = 'external';
    let timer;
    let timerSource = 'fallback';
    const watchers = [];
    const healthyWatchFallbackPollMs = Math.max(input.fallbackPollMs, input.healthyWatchFallbackPollMs ??
        Math.min(input.fallbackPollMs * 4, 2_000));
    const clearTimer = () => {
        if (!timer)
            return;
        clearTimeoutFn(timer);
        timer = undefined;
    };
    const schedule = (delayMs, source) => {
        if (!running)
            return;
        clearTimer();
        timerSource = source;
        timer = setTimeoutFn(() => {
            const source = timerSource;
            timer = undefined;
            run(source);
        }, delayMs);
        timer.unref?.();
    };
    const stop = () => {
        running = false;
        clearTimer();
        for (const watcher of watchers.splice(0)) {
            try {
                watcher.close();
            }
            catch {
                // Best effort shutdown; fallback polling is already stopped.
            }
        }
    };
    const run = (source) => {
        if (!running)
            return;
        if (processing) {
            rerunAfterCurrentPass = true;
            rerunAfterCurrentPassSource = source;
            return;
        }
        processing = true;
        let rerun = false;
        let rerunSource = 'external';
        let keepRunning = true;
        try {
            keepRunning = input.processSignals();
        }
        finally {
            processing = false;
            rerun = rerunAfterCurrentPass;
            rerunSource = rerunAfterCurrentPassSource;
            rerunAfterCurrentPass = false;
            rerunAfterCurrentPassSource = 'external';
        }
        if (!keepRunning) {
            stop();
            return;
        }
        schedule(rerun
            ? 0
            : source === 'watch'
                ? healthyWatchFallbackPollMs
                : input.fallbackPollMs, rerun ? rerunSource : 'fallback');
    };
    const trigger = (source = 'external') => {
        if (!running)
            return;
        if (processing) {
            rerunAfterCurrentPass = true;
            rerunAfterCurrentPassSource = source;
            return;
        }
        schedule(0, source);
    };
    const watchDirs = [
        ...new Set([input.inputDir, input.interactionBoundaryDir].filter((dir) => Boolean(dir))),
    ];
    for (const dir of watchDirs) {
        try {
            mkdirSync(dir, { recursive: true });
            const watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
                if (isRuntimeSignalFile(dir, input.inputDir, filename))
                    trigger('watch');
            });
            watcher.unref?.();
            watcher.on?.('error', (error) => {
                onWatchError?.({ dir, error });
                trigger('watch-error');
            });
            watchers.push(watcher);
        }
        catch (error) {
            onWatchError?.({ dir, error });
        }
    }
    schedule(input.fallbackPollMs, 'fallback');
    return { trigger, stop };
}
function isRuntimeSignalFile(dir, inputDir, filename) {
    if (!filename)
        return true;
    const name = Buffer.isBuffer(filename)
        ? filename.toString('utf-8')
        : filename;
    if (dir === inputDir && name === '_close')
        return true;
    return isCompleteJsonFile(path.basename(name));
}
function isCompleteJsonFile(filename) {
    return (filename.endsWith('.json') &&
        !filename.endsWith('.tmp') &&
        !filename.startsWith('.processing-'));
}
