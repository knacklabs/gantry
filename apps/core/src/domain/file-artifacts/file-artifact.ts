import type { BrandedId } from '../../shared/ids/branded-id.js';

export type FileArtifactId = BrandedId<'FileArtifactId'>;

export type FileArtifactStorageType = 'local-filesystem';

export const HOST_BROWSER_PAGINATION_PROBE_CREATED_BY =
  'host:browser-pagination-probe';
export const HOST_BROWSER_PAGINATION_PROBE_PROVENANCE = {
  origin: 'host',
  kind: 'browser_pagination_probe',
} as const;

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

// Thrown when a write supplies expectedVersion and the latest version observed
// inside the write's locked transaction does not match — i.e. a concurrent
// writer advanced the version between the caller's read and this write.
export class FileArtifactVersionConflictError extends Error {
  constructor(public readonly latestVersion: number) {
    super(
      `File artifact changed concurrently (latest version ${latestVersion}).`,
    );
    this.name = 'FileArtifactVersionConflictError';
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

export function isHostBrowserPaginationProbeArtifact(
  artifact: Pick<FileArtifact, 'createdBy' | 'metadata'>,
): boolean {
  const provenance = artifact.metadata?.provenance;
  return (
    artifact.createdBy === HOST_BROWSER_PAGINATION_PROBE_CREATED_BY &&
    !!provenance &&
    typeof provenance === 'object' &&
    !Array.isArray(provenance) &&
    (provenance as Record<string, unknown>).origin ===
      HOST_BROWSER_PAGINATION_PROBE_PROVENANCE.origin &&
    (provenance as Record<string, unknown>).kind ===
      HOST_BROWSER_PAGINATION_PROBE_PROVENANCE.kind
  );
}
