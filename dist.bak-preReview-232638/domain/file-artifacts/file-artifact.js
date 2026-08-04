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
    latestVersion;
    constructor(latestVersion) {
        super(`File artifact changed concurrently (latest version ${latestVersion}).`);
        this.latestVersion = latestVersion;
        this.name = 'FileArtifactVersionConflictError';
    }
}
export function describeFileArtifact(artifact) {
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
