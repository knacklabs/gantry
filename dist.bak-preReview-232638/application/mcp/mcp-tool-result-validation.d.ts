export type McpToolResultValidationAudit = {
    outputSchemaPresent: boolean;
    structuredResultValidated: boolean;
    toolResultError: boolean;
};
export type McpToolResultValidationPlan = {
    validate(result: unknown): McpToolResultValidationAudit;
};
export type McpOutputSchemaValidationResult = {
    valid: boolean;
    errors: readonly string[];
};
export type McpOutputSchemaValidationPlan = {
    validate(value: unknown): McpOutputSchemaValidationResult;
};
export type McpOutputSchemaValidator = (outputSchema: unknown) => McpOutputSchemaValidationPlan | null;
export declare class McpToolResultValidationError extends Error {
    constructor(message: string);
}
export declare function prepareMcpToolResultValidation(input: {
    serverName: string;
    toolName: string;
    outputSchema?: unknown;
}): McpToolResultValidationPlan;
