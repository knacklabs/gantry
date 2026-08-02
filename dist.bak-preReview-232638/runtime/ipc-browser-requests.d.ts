import type { IpcDeps } from './ipc-domain-types.js';
import type { RunnerControlPort } from './runner-control-port.js';
interface IpcBrowserRequestLogger {
    warn: (obj: Record<string, unknown>, message: string) => void;
    error: (obj: Record<string, unknown>, message: string) => void;
}
export declare function processBrowserRequestDirectory(input: {
    ipcBaseDir: string;
    sourceAgentFolder: string;
    browserRequestsDir: string;
    runnerControlPort: RunnerControlPort;
    deps: IpcDeps;
    logger: IpcBrowserRequestLogger;
}): void;
export {};
