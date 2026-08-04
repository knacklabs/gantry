import type { FileArtifact, FileArtifactId } from '../../../../domain/file-artifacts/file-artifact.js';
import type { FileArtifactListInput, FileArtifactStore, FileArtifactWriteInput } from '../../../../domain/ports/file-artifact-store.js';
import { LocalFileArtifactBytes } from '../../../artifacts/files/local-file-artifact-bytes.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresFileArtifactStore implements FileArtifactStore {
    private readonly db;
    private readonly bytes;
    constructor(db: CanonicalDb, bytes: LocalFileArtifactBytes);
    writeFileArtifact(input: FileArtifactWriteInput): Promise<{
        promotedFromArtifactId?: FileArtifactId | undefined;
        createdBy?: string | undefined;
        id: FileArtifactId;
        appId: string;
        agentId: string;
        virtualScope: string;
        virtualPath: string;
        version: number;
        storageType: "local-filesystem";
        storageRef: string;
        contentHash: string;
        sizeBytes: number;
        contentType: string;
        metadata: Record<string, unknown>;
        createdAt: string;
    }>;
    readFileArtifact(input: {
        id?: FileArtifactId;
        appId: string;
        agentId: string;
        virtualScope?: string;
        virtualPath?: string;
        version?: number;
    }): Promise<{
        artifact: FileArtifact;
        content: string | Buffer<ArrayBufferLike>;
    }>;
    listFileArtifacts(input: FileArtifactListInput): Promise<import("../../../../domain/file-artifacts/file-artifact.js").FileArtifactDescriptor[]>;
    promoteScratch(input: {
        appId: string;
        agentId: string;
        scratchPath: string;
        targetScope: string;
        targetPath: string;
        createdBy?: string;
        metadata?: Record<string, unknown>;
    }): Promise<{
        promotedFromArtifactId?: FileArtifactId | undefined;
        createdBy?: string | undefined;
        id: FileArtifactId;
        appId: string;
        agentId: string;
        virtualScope: string;
        virtualPath: string;
        version: number;
        storageType: "local-filesystem";
        storageRef: string;
        contentHash: string;
        sizeBytes: number;
        contentType: string;
        metadata: Record<string, unknown>;
        createdAt: string;
    }>;
    private nextVersion;
    private findArtifact;
    private queryRows;
    private fromRow;
}
