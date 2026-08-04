import { Ajv, type AnySchema } from 'ajv';

export const STRUCTURED_OUTPUT_ENVELOPE_SCHEMA = {
  type: 'object',
  properties: {
    json: {
      type: 'string',
      description: 'The complete JSON-encoded response object.',
    },
  },
  required: ['json'],
  additionalProperties: false,
  name: 'gantry_structured_output',
  title: 'gantry_structured_output',
} as const;

export function appendStructuredOutputContract(
  systemPrompt: string | undefined,
  responseSchema: Record<string, unknown> | undefined,
): string | undefined {
  if (!responseSchema) return systemPrompt;
  const instruction = [
    'For the final response, call gantry_structured_output exactly once.',
    'Set its json field to one JSON-encoded object that satisfies this JSON Schema:',
    JSON.stringify(responseSchema),
    'Do not wrap the JSON in Markdown or add text outside the structured-output call.',
  ].join('\n');
  return systemPrompt ? `${systemPrompt}\n\n${instruction}` : instruction;
}

export function serializeValidatedStructuredOutput(
  value: unknown,
  responseSchema: Record<string, unknown>,
): string {
  const json = envelopeJson(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('DeepAgents structured output returned invalid JSON.');
  }

  const validate = new Ajv({
    addUsedSchema: false,
    allErrors: true,
    strict: false,
  }).compile(responseSchema as AnySchema);
  if (!validate(parsed)) {
    const detail = validate.errors
      ?.slice(0, 5)
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ');
    throw new Error(
      `DeepAgents structured output failed response_schema validation${detail ? `: ${detail}` : '.'}`,
    );
  }
  return JSON.stringify(parsed);
}

function envelopeJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DeepAgents structured output did not return a response.');
  }
  const json = (value as Record<string, unknown>).json;
  if (typeof json !== 'string' || !json.trim()) {
    throw new Error('DeepAgents structured output did not return JSON.');
  }
  return json;
}
