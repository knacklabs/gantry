export interface SkillArtifactAsset {
  path: string;
  contentType?: string;
  content: Uint8Array;
}

export interface SkillArtifactBundle {
  assets: SkillArtifactAsset[];
}

export interface StoredSkillArtifact {
  storageType: 'local-filesystem' | 'object-store';
  storageRef: string;
  contentHash: string;
  sizeBytes: number;
}

export interface SkillArtifactStore {
  putSkillArtifact(input: {
    appId: string;
    skillId: string;
    skillName: string;
    bundle: SkillArtifactBundle;
  }): Promise<StoredSkillArtifact>;
  getSkillArtifact(storageRef: string): Promise<SkillArtifactBundle>;
}

export interface MaterializedSkillArtifact {
  storageRef: string;
  contentHash: string;
  /** Absolute path of the activated artifact directory on the local worker. */
  targetDir: string;
  sizeBytes: number;
}

/**
 * Worker-side fetch/verify/activate of a current-state artifact. A driver
 * downloads the artifact, verifies its sha256 against the recorded content
 * hash, and atomically swaps it into place. On mismatch it does NOT activate;
 * it moves the fetched copy to a quarantine area and throws
 * {@link ArtifactIntegrityError} for the caller to audit.
 */
export interface SkillArtifactMaterializer {
  materializeSkillArtifact(input: {
    storageRef: string;
    expectedContentHash: string;
    targetDir: string;
    quarantineDir: string;
  }): Promise<MaterializedSkillArtifact>;
}

/**
 * Typed quarantine error raised when a materialized artifact fails sha256
 * verification. The fetched copy has been moved to {@link quarantinePath} and
 * was NOT activated.
 */
export class ArtifactIntegrityError extends Error {
  readonly storageRef: string;
  readonly expectedContentHash: string;
  readonly actualContentHash: string;
  readonly quarantinePath: string;

  constructor(input: {
    storageRef: string;
    expectedContentHash: string;
    actualContentHash: string;
    quarantinePath: string;
  }) {
    super(
      `Artifact integrity check failed for ${input.storageRef}: expected ${input.expectedContentHash}, got ${input.actualContentHash}; quarantined at ${input.quarantinePath}`,
    );
    this.name = 'ArtifactIntegrityError';
    this.storageRef = input.storageRef;
    this.expectedContentHash = input.expectedContentHash;
    this.actualContentHash = input.actualContentHash;
    this.quarantinePath = input.quarantinePath;
  }
}
