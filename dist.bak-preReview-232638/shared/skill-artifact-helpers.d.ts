export type SkillAssetBytes = {
    path: string;
    content: Uint8Array;
};
export declare function normalizeSkillAssetPath(value: string): string;
export declare function readSkillMdAssetText(assets: SkillAssetBytes[]): string;
export declare function writeSkillAssets(assets: SkillAssetBytes[], targetDir: string): void;
export declare function readSkillFrontmatterName(content: string): string | undefined;
export declare function parseSkillFrontmatter(content: string): Record<string, string>;
export declare function cleanSkillMetadataText(value: string | undefined): string | undefined;
