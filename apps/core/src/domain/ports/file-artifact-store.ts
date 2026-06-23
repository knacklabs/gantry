import type {
  FileArtifact,
  FileArtifactDescriptor,
  FileArtifactId,
} from '../file-artifacts/file-artifact.js';

export interface FileArtifactOwner {
  appId: string;
  agentId: string;
}

export interface FileArtifactWriteInput extends FileArtifactOwner {
  virtualScope: string;
  virtualPath: string;
  content: Uint8Array | string;
  contentType?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
  promotedFromArtifactId?: FileArtifactId;
  // Optimistic concurrency: when set, the write fails with
  // FileArtifactVersionConflictError unless the latest stored version observed
  // inside the write's locked transaction equals this value.
  expectedVersion?: number;
}

export interface FileArtifactListInput extends FileArtifactOwner {
  virtualScope?: string;
  virtualPath?: string;
  version?: number;
  includeDeleted?: boolean;
  limit?: number;
}

export interface FileArtifactStore {
  writeFileArtifact(input: FileArtifactWriteInput): Promise<FileArtifact>;
  readFileArtifact(input: {
    id?: FileArtifactId;
    appId: string;
    agentId: string;
    virtualScope?: string;
    virtualPath?: string;
    version?: number;
  }): Promise<{ artifact: FileArtifact; content: Uint8Array | string }>;
  listFileArtifacts(
    input: FileArtifactListInput,
  ): Promise<FileArtifactDescriptor[]>;
  promoteScratch(input: {
    appId: string;
    agentId: string;
    scratchPath: string;
    targetScope: string;
    targetPath: string;
    createdBy?: string;
    metadata?: Record<string, unknown>;
  }): Promise<FileArtifact>;
}
