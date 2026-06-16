import fs, { type FSWatcher } from 'fs';
import path from 'path';

type WatchFactory = (
  filename: string,
  options: { persistent: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;

type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface RuntimeSignalPump {
  trigger(): void;
  stop(): void;
}

export interface RuntimeSignalPumpDeps {
  clearTimeout?: typeof clearTimeout;
  mkdirSync?: typeof fs.mkdirSync;
  onWatchError?: (input: { dir: string; error: unknown }) => void;
  setTimeout?: typeof setTimeout;
  watch?: WatchFactory;
}

export function startRuntimeSignalPump(input: {
  fallbackPollMs: number;
  inputDir: string;
  interactionBoundaryDir: string;
  processSignals: () => boolean;
  deps?: RuntimeSignalPumpDeps;
}): RuntimeSignalPump {
  const setTimeoutFn = input.deps?.setTimeout ?? setTimeout;
  const clearTimeoutFn = input.deps?.clearTimeout ?? clearTimeout;
  const watch = input.deps?.watch ?? fs.watch;
  const mkdirSync = input.deps?.mkdirSync ?? fs.mkdirSync;
  const onWatchError = input.deps?.onWatchError;
  let running = true;
  let processing = false;
  let rerunAfterCurrentPass = false;
  let timer: TimeoutHandle | undefined;
  const watchers: FSWatcher[] = [];

  const clearTimer = () => {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = undefined;
  };

  const schedule = (delayMs: number) => {
    if (!running) return;
    clearTimer();
    timer = setTimeoutFn(() => {
      timer = undefined;
      run();
    }, delayMs);
    timer.unref?.();
  };

  const stop = () => {
    running = false;
    clearTimer();
    for (const watcher of watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // Best effort shutdown; fallback polling is already stopped.
      }
    }
  };

  const run = () => {
    if (!running) return;
    if (processing) {
      rerunAfterCurrentPass = true;
      return;
    }
    processing = true;
    let rerun = false;
    let keepRunning = true;
    try {
      keepRunning = input.processSignals();
    } finally {
      processing = false;
      rerun = rerunAfterCurrentPass;
      rerunAfterCurrentPass = false;
    }
    if (!keepRunning) {
      stop();
      return;
    }
    schedule(rerun ? 0 : input.fallbackPollMs);
  };

  const trigger = () => {
    if (!running) return;
    if (processing) {
      rerunAfterCurrentPass = true;
      return;
    }
    schedule(0);
  };

  for (const dir of [input.inputDir, input.interactionBoundaryDir]) {
    try {
      mkdirSync(dir, { recursive: true });
      const watcher = watch(
        dir,
        { persistent: false },
        (_eventType, filename) => {
          if (isRuntimeSignalFile(dir, input.inputDir, filename)) trigger();
        },
      );
      watcher.unref?.();
      watcher.on?.('error', (error) => {
        onWatchError?.({ dir, error });
        trigger();
      });
      watchers.push(watcher);
    } catch (error) {
      onWatchError?.({ dir, error });
    }
  }

  schedule(input.fallbackPollMs);
  return { trigger, stop };
}

function isRuntimeSignalFile(
  dir: string,
  inputDir: string,
  filename: string | Buffer | null,
): boolean {
  if (!filename) return true;
  const name = Buffer.isBuffer(filename)
    ? filename.toString('utf-8')
    : filename;
  if (dir === inputDir && name === '_close') return true;
  return isCompleteJsonFile(path.basename(name));
}

function isCompleteJsonFile(filename: string): boolean {
  return (
    filename.endsWith('.json') &&
    !filename.endsWith('.tmp') &&
    !filename.startsWith('.processing-')
  );
}
