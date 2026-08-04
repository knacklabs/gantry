import type { FileArtifactStore } from '../../domain/ports/file-artifact-store.js';
import type { MessageFileAttachment, MessageSendOptions } from '../../domain/types.js';
export type CoreMessageFile = {
    source?: 'artifact';
    scope?: string;
    path: string;
    version?: number;
} | {
    source: 'workspace';
    path: string;
};
export interface CoreSendMessageInput {
    text: string;
    files?: CoreMessageFile[];
    sender?: string;
}
export interface CoreSendMessageContext {
    appId?: string;
    sourceAgentFolder: string;
    targetJid: string;
    threadId?: string;
    providerAccountId?: string;
    isScheduledJob?: boolean;
}
export interface CoreSendMessageDeps {
    sendMessage: (jid: string, text: string, options?: MessageSendOptions) => Promise<void>;
    getFileArtifactStore?: () => FileArtifactStore | undefined;
    readWorkspaceAttachment?: (sourceAgentFolder: string, virtualPath: string) => Promise<WorkspaceMessageAttachmentResolution>;
}
export type WorkspaceMessageAttachmentResolution = {
    status: 'resolved';
    attachment: MessageFileAttachment;
} | {
    status: 'missing';
} | {
    status: 'failed';
    reason: string;
};
export declare const MAX_MESSAGE_FILE_ATTACHMENT_BYTES: number;
export declare function sendCoreMessage(input: {
    message: CoreSendMessageInput;
    context: CoreSendMessageContext;
    deps: CoreSendMessageDeps;
}): Promise<{
    sent: boolean;
    message: string;
}>;
export declare function resolveCoreMessageAttachments(input: {
    appId?: string;
    sourceAgentFolder: string;
    text: string;
    files?: CoreMessageFile[];
    store?: FileArtifactStore;
    readWorkspaceAttachment?: CoreSendMessageDeps['readWorkspaceAttachment'];
}): Promise<{
    text: string;
    files?: MessageFileAttachment[];
}>;
