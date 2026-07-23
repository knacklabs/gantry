import fs, { type FSWatcher } from 'fs';

import { isPendingIpcJsonFile } from './ipc-filesystem.js';
import type {
  RunnerControlPort,
  RunnerControlRequestLane,
} from './runner-control-port.js';

const DEFAULT_WATCHED_REQUEST_LANES: readonly RunnerControlRequestLane[] = [
  'messages',
  'tasks',
  'memory-requests',
  'browser-requests',
  'permission-requests',
  'rich-interactions',
  'user-questions',
];

type WatchFactory = (
  filename: string,
  options: { persistent: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;

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

export class IpcRequestWakeupRegistry {
  private readonly lanes: readonly RunnerControlRequestLane[];
  private readonly onWatchError:
    IpcRequestWakeupRegistryDeps['onWatchError'] | undefined;
  private readonly watch: WatchFactory;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly failedWatchKeys = new Set<string>();

  constructor(
    private readonly input: {
      runnerControlPort: Pick<
        RunnerControlPort,
        'isTrustedRequestDir' | 'requestDir'
      >;
      trigger: (hint?: IpcRequestWakeupHint) => void;
      deps?: IpcRequestWakeupRegistryDeps;
    },
  ) {
    this.lanes = input.deps?.lanes ?? DEFAULT_WATCHED_REQUEST_LANES;
    this.onWatchError = input.deps?.onWatchError;
    this.watch = input.deps?.watch ?? fs.watch;
  }

  reconcile(workspaceFolders: readonly string[]): void {
    const desiredKeys = new Set<string>();
    for (const workspaceFolder of workspaceFolders) {
      for (const lane of this.lanes) {
        if (
          !this.input.runnerControlPort.isTrustedRequestDir(
            workspaceFolder,
            lane,
          )
        ) {
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
      if (desiredKeys.has(key)) continue;
      this.stopWatcher(key);
    }
  }

  stop(): void {
    for (const key of Array.from(this.watchers.keys())) {
      this.stopWatcher(key);
    }
    this.failedWatchKeys.clear();
  }

  private startWatcher(input: {
    workspaceFolder: string;
    lane: RunnerControlRequestLane;
    key: string;
  }): void {
    const { workspaceFolder, lane, key } = input;
    const dir = this.input.runnerControlPort.requestDir(workspaceFolder, lane);
    try {
      const watcher = this.watch(
        dir,
        { persistent: false },
        (_eventType, filename) => {
          const wakeup = classifyIpcWakeup(filename);
          if (wakeup === 'ignored') return;
          if (wakeup === 'specific') {
            this.input.trigger({ workspaceFolder, lane });
          } else {
            this.input.trigger();
          }
        },
      );
      watcher.unref?.();
      watcher.on?.('error', (error) => {
        this.stopWatcher(key);
        this.reportWatchError({ workspaceFolder, lane, key, error });
        this.input.trigger();
      });
      this.watchers.set(key, watcher);
      this.failedWatchKeys.delete(key);
    } catch (error) {
      this.reportWatchError({ workspaceFolder, lane, key, error });
    }
  }

  private stopWatcher(key: string): void {
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    this.watchers.delete(key);
    try {
      watcher.close();
    } catch {
      // Best effort shutdown; fallback polling remains authoritative.
    }
  }

  private reportWatchError(input: {
    workspaceFolder: string;
    lane: RunnerControlRequestLane;
    key: string;
    error: unknown;
  }): void {
    if (this.failedWatchKeys.has(input.key)) return;
    this.failedWatchKeys.add(input.key);
    this.onWatchError?.({
      workspaceFolder: input.workspaceFolder,
      lane: input.lane,
      error: input.error,
    });
  }
}

function watchKey(
  workspaceFolder: string,
  lane: RunnerControlRequestLane,
): string {
  return `${workspaceFolder}\0${lane}`;
}

function classifyIpcWakeup(
  filename: string | Buffer | null,
): 'specific' | 'unknown' | 'ignored' {
  if (!filename) return 'unknown';
  const name = Buffer.isBuffer(filename)
    ? filename.toString('utf-8')
    : filename;
  return isPendingIpcJsonFile(name) ? 'specific' : 'ignored';
}
