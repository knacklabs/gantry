export declare const TRIGGER_RATE_WINDOW_MS = 60000;
export declare const TRIGGER_RATE_LIMIT_PER_APP = 120;
export declare const TRIGGER_RATE_LIMIT_PER_JOB = 20;
export type RateLimiter = {
    consume: (key: string, limit: number) => boolean;
};
export declare function createRateLimiter(windowMs?: number): RateLimiter;
