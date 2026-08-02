export type ParsedSkillPackageAssets = {
    ok: true;
    assets: Array<{
        path: string;
        contentType?: string;
        content: Uint8Array;
    }>;
    fileSummaries: Array<{
        path: string;
        sizeBytes: number;
        fingerprint: string;
    }>;
    skillMarkdownPreview: {
        path: string;
        content: string;
        truncated: boolean;
    };
    metadata: {
        name?: string;
        description?: string;
        requiredEnvVars: string[];
    };
    totalSizeBytes: number;
} | {
    ok: false;
    error: string;
};
export declare function parseSkillPackageAssets(files: unknown): ParsedSkillPackageAssets;
