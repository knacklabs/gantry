export declare const BARE_SAFE_EXECUTABLES: Set<string>;
export declare const GENERIC_READ_EXECUTABLES: Set<string>;
export declare function sedReadFileArgs(args: readonly string[]): string[] | undefined;
export declare function genericReadFileArgs(executable: string, args: readonly string[]): string[] | undefined;
export declare function hasHiddenPathSegment(value: string): boolean;
export declare function normalizeCapabilityId(value: string): string;
export declare function capabilityTokens(value: string): string[];
