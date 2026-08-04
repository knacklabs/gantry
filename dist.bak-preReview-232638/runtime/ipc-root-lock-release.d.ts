import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
export declare function releaseIpcRootLock(input: {
    lockPath: string | undefined;
    runnerControlPort: FilesystemRunnerControlPort | undefined;
    warn: (context: Record<string, unknown>, message: string) => void;
}): boolean;
