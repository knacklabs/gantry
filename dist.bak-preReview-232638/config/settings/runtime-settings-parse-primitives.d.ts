export declare function parseStringArrayValue(raw: unknown, pathPrefix: string, fallback?: string[], validateItem?: (value: string) => string | void): string[];
export declare function parseOptionalStringValue(raw: unknown, pathPrefix: string): string | undefined;
export declare function parseStringValue(raw: unknown, pathPrefix: string, fallback?: string): string;
export declare function parseBooleanValue(raw: unknown, pathPrefix: string, fallback?: boolean): boolean;
export declare function parsePositiveIntegerValue(raw: unknown, pathPrefix: string, fallback: number): number;
export declare function parseNonNegativeIntegerValue(raw: unknown, pathPrefix: string, fallback: number): number;
export declare function containsControlCharacter(value: string): boolean;
