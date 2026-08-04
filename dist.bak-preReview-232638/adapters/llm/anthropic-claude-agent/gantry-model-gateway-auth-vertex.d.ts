export declare function getVertexServiceAccountBearerToken(input: {
    serviceAccountJson: string;
    expectedProjectId: string;
    nowMs?: number;
    tokenRequestTimeoutMs?: number;
}): Promise<string>;
export declare function getVertexAdcBearerToken(input?: {
    nowMs?: number;
    tokenRequestTimeoutMs?: number;
}): Promise<string>;
export declare function clearVertexTokenCacheForTest(): void;
