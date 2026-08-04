export declare const SENSITIVE_TOOL_INPUT_KEY_PATTERN: RegExp;
export declare function redactSensitiveToolInputString(value: string): string;
export declare function sanitizeIpcToolInput(value: unknown, maxStringLength?: number): {
    toolInput?: Record<string, unknown>;
    altered: boolean;
    alteredPaths: string[];
    redactedPaths: string[];
    truncatedPaths: string[];
};
