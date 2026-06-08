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
