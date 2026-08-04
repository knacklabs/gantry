import { type RichInteractionRequest } from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { IpcInteractionLogger } from './ipc-interaction-processing.js';
export declare function processRichInteractionIpc(input: {
    request: RichInteractionRequest;
    sourceAgentFolder: string;
    deps: IpcDeps;
    ipcBaseDir: string;
    file: string;
    claimedPath: string;
    logger: IpcInteractionLogger;
}): Promise<void>;
