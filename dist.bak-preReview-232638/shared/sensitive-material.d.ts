export declare function classifySensitiveMemoryMaterial(text: string): string | null;
export declare function classifyPromptInjectionMemoryMaterial(text: string): string | null;
export declare function classifyUnsafeMemoryMaterial(text: string): string | null;
export declare function detectPotentialUnredactedSecret(text: string): string | null;
export declare function redactSensitiveText(raw: string): string;
export declare function sanitizeOutboundLlmText(raw: string): {
    text: string;
    redacted: boolean;
    blocked: boolean;
    reason?: string;
};
