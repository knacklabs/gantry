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

export type McpOutputSchemaValidator = (
  outputSchema: unknown,
) => McpOutputSchemaValidationPlan | null;

export class McpToolResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolResultValidationError';
  }
}

export function prepareMcpToolResultValidation(input: {
  serverName: string;
  toolName: string;
  outputSchema?: unknown;
}): McpToolResultValidationPlan {
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
        throw new McpToolResultValidationError(
          `MCP tool ${input.serverName}.${input.toolName} declared outputSchema but returned no structuredContent.`,
        );
      }
      const validation = validateStructuredContent.validate(
        record.structuredContent,
      );
      if (!validation.valid) {
        throw new McpToolResultValidationError(
          `MCP tool ${input.serverName}.${input.toolName} structuredContent failed outputSchema validation: ${validation.errors.slice(0, 3).join('; ')}.`,
        );
      }
      return {
        outputSchemaPresent: true,
        structuredResultValidated: true,
        toolResultError,
      };
    },
  };
}

function isMcpToolErrorResult(result: unknown): boolean {
  const record = asRecord(result);
  return record?.isError === true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
import { validateMcpOutputSchema } from './mcp-output-schema-validator.js';
