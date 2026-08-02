export interface EgressSettings {
    denylist: string[];
}
export interface EgressPolicyMatch {
    host: string;
    matchedPattern: string;
    reason: string;
}
export declare function normalizeEgressHost(host: string): string;
export declare function validateEgressDenylistPattern(pattern: string): string;
export declare function evaluateEgressDenylist(input: {
    settings: EgressSettings;
    host: string;
}): EgressPolicyMatch | undefined;
export declare function evaluateNonPublicEgressAddress(input: {
    host: string;
    address: string;
}): EgressPolicyMatch | undefined;
