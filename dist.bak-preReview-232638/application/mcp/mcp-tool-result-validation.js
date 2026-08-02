export class McpToolResultValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'McpToolResultValidationError';
    }
}
export function prepareMcpToolResultValidation(input) {
    const outputSchema = input.outputSchema;
    if (outputSchema === undefined) {
        return {
            validate: (result) => ({
                outputSchemaPresent: false,
                structuredResultValidated: false,
                toolResultError: isMcpToolErrorResult(result),
            }),
        };
    }
    const validateStructuredContent = validateMcpOutputSchema(outputSchema);
    return {
        validate: (result) => {
            const toolResultError = isMcpToolErrorResult(result);
            if (toolResultError || !validateStructuredContent) {
                return {
                    outputSchemaPresent: true,
                    structuredResultValidated: false,
                    toolResultError,
                };
            }
            const record = asRecord(result);
            if (!record || !Object.hasOwn(record, 'structuredContent')) {
                throw new McpToolResultValidationError(`MCP tool ${input.serverName}.${input.toolName} declared outputSchema but returned no structuredContent.`);
            }
            const validation = validateStructuredContent.validate(record.structuredContent);
            if (!validation.valid) {
                throw new McpToolResultValidationError(`MCP tool ${input.serverName}.${input.toolName} structuredContent failed outputSchema validation: ${validation.errors.slice(0, 3).join('; ')}.`);
            }
            return {
                outputSchemaPresent: true,
                structuredResultValidated: true,
                toolResultError,
            };
        },
    };
}
function isMcpToolErrorResult(result) {
    const record = asRecord(result);
    return record?.isError === true;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
import { validateMcpOutputSchema } from './mcp-output-schema-validator.js';
