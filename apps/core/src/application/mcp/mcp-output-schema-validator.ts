import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';

import type { McpOutputSchemaValidator } from './mcp-tool-result-validation.js';

const validator = new Ajv({ allErrors: true, strict: false });

export const validateMcpOutputSchema: McpOutputSchemaValidator = (
  outputSchema,
) => {
  if (typeof outputSchema !== 'boolean' && !isRecord(outputSchema)) {
    return null;
  }
  let validate: ValidateFunction;
  try {
    validate = validator.compile(outputSchema as AnySchema);
  } catch {
    return null;
  }
  return {
    validate: (value) => {
      const valid = validate(value);
      return { valid, errors: valid ? [] : formatErrors(validate) };
    },
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatErrors(validate: ValidateFunction): string[] {
  const errors = validate.errors ?? [];
  if (errors.length === 0) return ['/ is invalid'];
  return errors.slice(0, 3).map((error) => {
    const path = error.instancePath || '/';
    return `${path} ${error.message ?? 'is invalid'}`;
  });
}
