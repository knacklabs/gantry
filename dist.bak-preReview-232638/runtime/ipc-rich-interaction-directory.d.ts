import type { IpcDeps } from './ipc-domain-types.js';
import type { ConversationRoute } from '../domain/types.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
declare const RICH_INTERACTION_LANE = "rich-interactions";
type RichInteractionDirectoryLogger = {
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
};
export declare function processRichInteractionRequestDirectory(input: {
    sourceAgentFolder: string;
    processScope: 'all' | 'hinted';
    shouldProcessRequestLane(sourceAgentFolder: string, lane: typeof RICH_INTERACTION_LANE): boolean;
    folderTargetJid: Map<string, string>;
    folderTargetJids: Map<string, Set<string>>;
    groupRegistry: Record<string, ConversationRoute>;
    inFlightInteractionIpc: Set<string>;
    maxInFlightInteractionIpc: number;
    runnerControlPort: FilesystemRunnerControlPort;
    deps: IpcDeps;
    ipcBaseDir: string;
    logger: RichInteractionDirectoryLogger;
}): void;
export {};
