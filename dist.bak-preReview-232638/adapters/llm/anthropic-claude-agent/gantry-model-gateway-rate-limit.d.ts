export interface GatewayProviderRateLimit {
    requestsPerMinute: number;
}
export interface GatewayProviderRateLimits {
    providers: Record<string, GatewayProviderRateLimit>;
}
export declare class GatewayRateLimiter {
    private readonly getLimits?;
    private readonly windows;
    constructor(getLimits?: (() => GatewayProviderRateLimits) | undefined);
    requestsPerMinute(providerId: string): number | undefined;
    admit(appId: string, providerId: string, limit: number, weight?: number, nowMs?: number): boolean;
    clear(): void;
}
export declare function applyRateCap(input: {
    limiter: GatewayRateLimiter;
    appId: string;
    providerId: string;
    weight?: number;
    audit: (limit: number) => Promise<unknown> | unknown;
    reject: (limit: number) => void;
}): Promise<boolean>;
