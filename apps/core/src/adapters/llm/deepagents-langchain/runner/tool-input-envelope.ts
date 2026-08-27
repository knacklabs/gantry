import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { toJSONSchema, z } from 'zod';
import { handleFileToolAction } from '../../../../runner/mcp/tools/file.js';

// Gemini requires the portable envelope. OpenAI Responses accepts Gantry's
// native function schemas and should see them directly; otherwise the model
// follows the documented native schema while the wrapper expects `{json}`.
const ENVELOPE_PROVIDERS = new Set(['gemini']);

export function envelopeToolsForProvider(
  tools: readonly StructuredToolInterface[],
  provider: string,
): StructuredToolInterface[] {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === 'openai') return tools.map(closeOpenAiToolSchema);
  if (!ENVELOPE_PROVIDERS.has(normalizedProvider)) return [...tools];
  return tools.map((original) =>
    isEmptyObjectSchema(original.schema)
      ? emptyObjectTool(original)
      : envelopeTool(original),
  );
}

function closeOpenAiToolSchema(
  original: StructuredToolInterface,
): StructuredToolInterface {
  const schema =
    original.schema &&
    typeof original.schema === 'object' &&
    '_zod' in original.schema
      ? toJSONSchema(original.schema as z.ZodType)
      : original.schema;
  if (
    hasDynamicObjectSchema(schema) ||
    hasUntypedPropertySchema(schema) ||
    hasUnsupportedOpenAiKeyword(schema)
  ) {
    return envelopeTool(original);
  }
  const strictSchema = strictObjectSchemas(schema);
  return new Proxy(original, {
    get(target, property, receiver) {
      if (property === 'schema') return strictSchema;
      if (property === 'invoke') {
        return async (input: unknown): Promise<unknown> =>
          invokeForAgent(original, stripOptionalNulls(input, schema));
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function hasUnsupportedOpenAiKeyword(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsupportedOpenAiKeyword);
  if (!value || typeof value !== 'object') return false;
  const schema = value as Record<string, unknown>;
  if ('oneOf' in schema || 'allOf' in schema || 'not' in schema) return true;
  return Object.values(schema).some(hasUnsupportedOpenAiKeyword);
}

function strictObjectSchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictObjectSchemas);
  if (!value || typeof value !== 'object') return value;
  const original = value as Record<string, unknown>;
  const schema = Object.fromEntries(
    Object.entries(original)
      .filter(([key]) => key !== 'format')
      .map(([key, item]) => [key, strictObjectSchemas(item)]),
  );
  const nullable = collapseNullableAnyOf(schema);
  if (nullable) return strictObjectSchemas(nullable);
  if (schema.type === 'object') {
    schema.additionalProperties = false;
    const properties = schema.properties;
    if (
      properties &&
      typeof properties === 'object' &&
      !Array.isArray(properties)
    ) {
      const required = new Set(
        Array.isArray(original.required) ? original.required : [],
      );
      schema.properties = Object.fromEntries(
        Object.entries(properties).map(([key, item]) => [
          key,
          required.has(key) ? item : nullableSchema(item),
        ]),
      );
      schema.required = Object.keys(properties);
    }
  }
  return schema;
}

function nullableSchema(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const schema = value as Record<string, unknown>;
    if (
      schema.type === 'null' ||
      (Array.isArray(schema.type) && schema.type.includes('null'))
    )
      return value;
    if (typeof schema.type === 'string')
      return { ...schema, type: [schema.type, 'null'] };
  }
  return { anyOf: [value, { type: 'null' }] };
}

function collapseNullableAnyOf(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length !== 2)
    return undefined;
  const branches = schema.anyOf as Array<Record<string, unknown>>;
  const nullBranch = branches.find((branch) => branch?.type === 'null');
  const valueBranch = branches.find((branch) => branch !== nullBranch);
  if (!nullBranch || !valueBranch || typeof valueBranch.type !== 'string')
    return undefined;
  const { anyOf: _anyOf, ...siblings } = schema;
  return { ...siblings, ...valueBranch, type: [valueBranch.type, 'null'] };
}

function hasDynamicObjectSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDynamicObjectSchema);
  if (!value || typeof value !== 'object') return false;
  const schema = value as Record<string, unknown>;
  if (
    schema.type === 'object' &&
    schema.additionalProperties !== false &&
    !schema.properties
  )
    return true;
  return Object.values(schema).some(hasDynamicObjectSchema);
}

function hasUntypedPropertySchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUntypedPropertySchema);
  if (!value || typeof value !== 'object') return false;
  const schema = value as Record<string, unknown>;
  const properties = schema.properties;
  if (
    properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties)
  ) {
    for (const property of Object.values(properties)) {
      if (!property || typeof property !== 'object' || Array.isArray(property))
        return true;
      const definition = property as Record<string, unknown>;
      if (
        definition.type === undefined &&
        definition.anyOf === undefined &&
        definition.oneOf === undefined &&
        definition.enum === undefined &&
        definition.const === undefined &&
        definition.$ref === undefined
      )
        return true;
    }
  }
  return Object.values(schema).some(hasUntypedPropertySchema);
}

function stripOptionalNulls(input: unknown, schema: unknown): unknown {
  if (Array.isArray(input)) {
    const itemSchema =
      schema && typeof schema === 'object'
        ? (schema as Record<string, unknown>).items
        : undefined;
    return input.map((item) => stripOptionalNulls(item, itemSchema));
  }
  if (
    !input ||
    typeof input !== 'object' ||
    !schema ||
    typeof schema !== 'object'
  )
    return input;
  const definition = schema as Record<string, unknown>;
  if (Array.isArray(definition.anyOf)) {
    return definition.anyOf.reduce(
      (value, branch) => stripOptionalNulls(value, branch),
      input,
    );
  }
  const properties = definition.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  )
    return input;
  const required = new Set(
    Array.isArray(definition.required) ? definition.required : [],
  );
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).flatMap(([key, value]) =>
      value === null && !required.has(key)
        ? []
        : [
            [
              key,
              stripOptionalNulls(
                value,
                (properties as Record<string, unknown>)[key],
              ),
            ],
          ],
    ),
  );
}

function emptyObjectTool(
  original: StructuredToolInterface,
): StructuredToolInterface {
  return tool(
    async (): Promise<unknown> => {
      try {
        return await original.invoke({} as never);
      } catch (error) {
        if (original.name !== 'job_checkpoint_status') throw error;
        const detail =
          error instanceof Error ? error.message : 'Tool action failed.';
        return `${original.name} failed: ${detail.slice(0, 2_000)} Inspect the error and retry the checkpoint read.`;
      }
    },
    {
      name: original.name,
      description: original.description,
      schema: z.object({}),
    },
  );
}

async function invokeForAgent(
  original: StructuredToolInterface,
  input: unknown,
): Promise<unknown> {
  try {
    return await original.invoke(input as never);
  } catch (error) {
    const firstDetail =
      error instanceof Error ? error.message : 'Tool action failed.';
    if (isToolSchemaValidationError(firstDetail) && containsNull(input)) {
      try {
        return await original.invoke(stripAllNulls(input) as never);
      } catch (retryError) {
        error = retryError;
      }
    }
    const detail =
      error instanceof Error ? error.message : 'Tool action failed.';
    if (
      !isRecoverableAgentTool(original.name) &&
      !isToolSchemaValidationError(detail)
    )
      throw error;
    return `${original.name} failed: ${detail.slice(0, 2_000)} Inspect the error. Correct the arguments or approach and retry.`;
  }
}

function isToolSchemaValidationError(detail: string): boolean {
  return (
    detail.includes('tool input did not match expected schema') ||
    detail.includes('MCP error -32602') ||
    detail.includes('Input validation error') ||
    detail.includes('Invalid arguments for tool')
  );
}

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  return Boolean(
    value &&
    typeof value === 'object' &&
    Object.values(value).some(containsNull),
  );
}

function stripAllNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAllNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      item === null ? [] : [[key, stripAllNulls(item)]],
    ),
  );
}

function isRecoverableAgentTool(name: string): boolean {
  const normalizedName = name.replace(/^mcp__[^_]+__/u, '');
  return (
    normalizedName.startsWith('browser_') ||
    normalizedName === 'mcp_call_tool' ||
    normalizedName === 'job_checkpoint_status' ||
    normalizedName === 'scheduler_get_job' ||
    normalizedName === 'scheduler_list_runs' ||
    normalizedName === 'scheduler_list_events' ||
    normalizedName === 'scheduler_wait_for_events'
  );
}

function isEmptyObjectSchema(
  schema: StructuredToolInterface['schema'],
): boolean {
  try {
    const jsonSchema =
      schema && typeof schema === 'object' && '_zod' in schema
        ? toJSONSchema(schema as z.ZodType)
        : schema;
    if (!jsonSchema || typeof jsonSchema !== 'object') return false;
    const properties = (jsonSchema as { properties?: unknown }).properties;
    return (
      (jsonSchema as { type?: unknown }).type === 'object' &&
      properties !== null &&
      typeof properties === 'object' &&
      Object.keys(properties).length === 0
    );
  } catch {
    return false;
  }
}

function envelopeTool(
  original: StructuredToolInterface,
): StructuredToolInterface {
  const schema = readableSchema(original.schema);
  return tool(
    async ({ json }): Promise<unknown> => {
      let input: unknown;
      try {
        const artifactId = /^artifact:(file-artifact:[A-Za-z0-9-]+)$/u.exec(
          json.trim(),
        )?.[1];
        input = JSON.parse(
          artifactId
            ? await handleFileToolAction({ action: 'read', artifactId })
            : json,
        );
        input = unwrapMatchingDirectMcpCall(original.name, input);
      } catch {
        return `${original.name} failed: arguments were not valid JSON. Correct the json field or pass artifact:file-artifact:<id> for a job-scoped JSON input artifact, then retry.`;
      }
      return invokeForAgent(original, input);
    },
    {
      name: original.name,
      description: [
        original.description,
        'Pass arguments in the json field as one JSON-encoded value matching this schema. For large or nested inputs, first save the complete arguments object as a job-scoped JSON FileArtifact and pass artifact:file-artifact:<id> instead:',
        schema,
      ].join('\n'),
      schema: z
        .object({
          json: z.string().describe('JSON-encoded arguments for this tool.'),
        })
        .strict(),
    },
  );
}

function unwrapMatchingDirectMcpCall(
  directToolName: string,
  input: unknown,
): unknown {
  const match = /^mcp__(.+)__([A-Za-z0-9_.-]+)$/u.exec(directToolName);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const wrapper = input as Record<string, unknown>;
  const wrapperMatchesDirectTool = match
    ? wrapper.serverName === match[1] && wrapper.toolName === match[2]
    : directToolName !== 'mcp_call_tool' && wrapper.toolName === directToolName;
  if (
    !wrapperMatchesDirectTool ||
    !wrapper.arguments ||
    typeof wrapper.arguments !== 'object' ||
    Array.isArray(wrapper.arguments)
  ) {
    return input;
  }
  return wrapper.arguments;
}

function readableSchema(schema: StructuredToolInterface['schema']): string {
  try {
    if (schema && typeof schema === 'object' && '_zod' in schema) {
      return JSON.stringify(toJSONSchema(schema as z.ZodType));
    }
    return JSON.stringify(schema);
  } catch {
    return '{"type":"object"}';
  }
}
