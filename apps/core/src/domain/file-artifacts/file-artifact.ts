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

export class FileArtifactNotFoundError extends Error {
  constructor(message = 'File artifact not found') {
    super(message);
    this.name = 'FileArtifactNotFoundError';
  }
}

export function describeFileArtifact(
  artifact: FileArtifact,
): FileArtifactDescriptor {
  return {
    id: artifact.id,
    scope: artifact.virtualScope,
    path: artifact.virtualPath,
    version: artifact.version,
    contentHash: artifact.contentHash,
    sizeBytes: artifact.sizeBytes,
    contentType: artifact.contentType,
    createdAt: artifact.createdAt,
    ...(artifact.createdBy ? { createdBy: artifact.createdBy } : {}),
    ...(artifact.promotedFromArtifactId
      ? { promotedFromArtifactId: artifact.promotedFromArtifactId }
      : {}),
  };
}
