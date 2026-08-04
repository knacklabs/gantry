export declare function parseJsonArray(value: string | null | undefined): string[];
export declare function parseJsonObject(value: unknown): Record<string, unknown>;
export declare function isUnsafeEvidence(evidence: {
    metadataJson: unknown;
}): boolean;
