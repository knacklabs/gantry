import type { BrandedId } from '../../shared/ids/branded-id.js';
export type FileArtifactId = BrandedId<'FileArtifactId'>;
export type FileArtifactStorageType = 'local-filesystem';
export interface FileArtifact {
    id: FileArtifactId;
    appId: string;
    agentId: string;
    virtualScope: string;
    virtualPath: string;
    version: number;
    storageType: FileArtifactStorageType;
    storageRef: string;
    contentHash: string;
    sizeBytes: number;
    contentType: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    createdBy?: string;
    promotedFromArtifactId?: FileArtifactId;
    deletedAt?: string;
}
export interface FileArtifactDescriptor {
    id: FileArtifactId;
    scope: string;
    path: string;
    version: number;
    contentHash: string;
    sizeBytes: number;
    contentType: string;
    createdAt: string;
    createdBy?: string;
    promotedFromArtifactId?: FileArtifactId;
}
export declare class FileArtifactNotFoundError extends Error {
    constructor(message?: string);
}
export declare class FileArtifactVersionConflictError extends Error {
    readonly latestVersion: number;
    constructor(latestVersion: number);
}
export declare function describeFileArtifact(artifact: FileArtifact): FileArtifactDescriptor;
