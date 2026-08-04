export type IngressTarget = Record<string, unknown> & {
    kind: string;
};
export declare function assertTargetAllowed(metadata: unknown, target: IngressTarget): void;
export declare function readString(record: Record<string, unknown>, key: string): string;
export declare function readOptionalString(record: Record<string, unknown>, key: string): string | null;
export declare function readVariables(value: unknown): Record<string, string>;
export declare function readTemplate(metadata: unknown, templateId: string): {
    name: string;
    prompt: string;
    sessionId: string;
    allowedVariables?: string[];
};
export declare function validateIngressMetadata(metadata: unknown): unknown;
export declare function renderTemplate(prompt: string, variables: Record<string, string>): string;
