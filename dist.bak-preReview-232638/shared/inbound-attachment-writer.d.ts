export interface InboundAttachmentReader {
    read: () => Promise<{
        done: boolean;
        value?: Uint8Array;
    }>;
}
export type InboundAttachmentWriteResult = {
    status: 'written';
    bytes: number;
} | {
    status: 'too-large';
    bytes: number;
};
export declare function createInboundAttachmentStorageRef(filename: string): string;
export declare function writeInboundAttachment(input: {
    workspaceRoot: string;
    workspaceRelativePath: string;
    content: Uint8Array | InboundAttachmentReader;
    maxBytes: number;
}): Promise<InboundAttachmentWriteResult>;
