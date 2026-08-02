export interface Clock {
    now: () => Date;
    nowMs: () => number;
}
export declare const systemClock: Clock;
export declare function fixedClock(input: Date | number | string): Clock;
export declare function nowIso(clock?: Clock): string;
export declare function nowMs(clock?: Clock): number;
export declare function nowDate(clock?: Clock): Date;
export declare function toIso(input: Date | number | string): string;
export declare function parseIso(value: string): Date | undefined;
export declare function formatDurationMs(durationMs: number): string;
export declare function sleep(ms: number): Promise<void>;
