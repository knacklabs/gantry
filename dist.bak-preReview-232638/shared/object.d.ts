export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function toTrimmedString(value: unknown, opts?: {
    maxLen?: number;
    allowEmpty?: boolean;
}): string | undefined;
