import type { CoreMessageFile } from '../application/core-tools/send-message.js';
import type { IpcDeps } from './ipc-domain-types.js';
export type ParsedIpcMessageFile = CoreMessageFile;
export declare function parseIpcMessageFiles(rawFiles: unknown): ParsedIpcMessageFile[];
export declare function appendOwnedFileArtifactDegradeText(input: {
    deps: IpcDeps;
    appId?: string;
    sourceAgentFolder: string;
    text: string;
    files?: ParsedIpcMessageFile[];
}): Promise<string>;
export declare function resolveOwnedFileArtifactMessage(input: {
    deps: IpcDeps;
    appId?: string;
    sourceAgentFolder: string;
    text: string;
    files?: ParsedIpcMessageFile[];
}): Promise<{
    text: string;
    files?: import("../domain/types.js").MessageFileAttachment[];
}>;
