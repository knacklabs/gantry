export declare function mergeAgentEgressNoProxy(...values: readonly (string | undefined)[]): string;
export declare function applyAgentEgressNoProxyEnv(env: Record<string, string | undefined>, options?: {
    externalBypass?: boolean;
}): void;
