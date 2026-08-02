/**
 * Typed quarantine error raised when a materialized artifact fails sha256
 * verification. The fetched copy has been moved to {@link quarantinePath} and
 * was NOT activated.
 */
export class ArtifactIntegrityError extends Error {
    storageRef;
    expectedContentHash;
    actualContentHash;
    quarantinePath;
    constructor(input) {
        super(`Artifact integrity check failed for ${input.storageRef}: expected ${input.expectedContentHash}, got ${input.actualContentHash}; quarantined at ${input.quarantinePath}`);
        this.name = 'ArtifactIntegrityError';
        this.storageRef = input.storageRef;
        this.expectedContentHash = input.expectedContentHash;
        this.actualContentHash = input.actualContentHash;
        this.quarantinePath = input.quarantinePath;
    }
}
