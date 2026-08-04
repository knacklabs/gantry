import type { IpcDeps } from './ipc-domain-types.js';
import type { parseTaskIpcData } from './ipc-task-parsing.js';
import type { RunnerControlPort } from './runner-control-port.js';
export declare const isLongRunningTask: (type: string) => boolean;
export declare function processLongRunningTaskIpc(input: {
    data: ReturnType<typeof parseTaskIpcData>;
    sourceAgentFolder: string;
    deps: IpcDeps;
    ipcBaseDir: string;
    file: string;
    claimedPath: string;
    runnerControlPort: RunnerControlPort;
}): Promise<void>;
