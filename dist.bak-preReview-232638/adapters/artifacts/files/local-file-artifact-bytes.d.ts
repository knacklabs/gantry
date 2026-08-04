import { type FileArtifactId } from '../../../domain/file-artifacts/file-artifact.js';
export interface StoredFileArtifactBytes {
    storageRef: string;
    contentHash: string;
    sizeBytes: number;
}
export declare function hashFileArtifactBytes(content: Uint8Array | string): string;
export declare class LocalFileArtifactBytes {
    private readonly root;
    constructor(root: string);
    putBytes(input: {
        id: FileArtifactId;
        appId: string;
        agentId: string;
        virtualScope: string;
        virtualPath: string;
        version: number;
        content: Uint8Array | string;
    }): Promise<StoredFileArtifactBytes>;
    getBytes(storageRef: string, expected: {
        hash: string;
        sizeBytes: number;
    }): Promise<Buffer>;
    removeBytes(storageRef: string): Promise<void>;
    healthCheck(): Promise<void>;
    private resolve;
}
