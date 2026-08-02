import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
export declare function acquireIpcRootLockForWatcher(input: {
    runnerControlPort: FilesystemRunnerControlPort;
    warn: (context: Record<string, unknown>, message: string) => void;
}): string | undefined;
