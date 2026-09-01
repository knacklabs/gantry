import { Ajv, type AnySchema } from 'ajv';

export class DeepAgentStructuredOutputError extends Error {
  constructor(
    message: string,
    readonly attemptedJson?: string,
  ) {
    super(message);
    this.name = 'DeepAgentStructuredOutputError';
  }
}

export function structuredOutputContinuationPrompt(
  error: DeepAgentStructuredOutputError,
  continuationMessage: string,
): string {
  return [
    continuationMessage,
    'The previous completion attempt was not terminal and also failed the response schema. Continue the workflow; do not merely reformat or repeat that conclusion.',
    error.message,
    ...(error.attemptedJson
      ? [
          'Previous invalid completion attempt:',
          error.attemptedJson.slice(0, 16_000),
        ]
      : []),
  ].join('\n\n');
}

export function preserveOriginalTaskPrompt(
  originalPrompt: string,
  continuationPrompt: string,
): string {
  return [
    originalPrompt,
    'RUNTIME_CONTINUATION',
    continuationPrompt,
  ].join('\n\n');
}

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
  transport: 'provider' | 'tool' = 'tool',
): string | undefined {
  if (!responseSchema) return systemPrompt;
  const instruction = [
    transport === 'provider'
      ? 'For the final response, use the configured structured-output response exactly once.'
      : 'For the final response, call gantry_structured_output exactly once.',
    'Set its json field to one JSON-encoded object that satisfies this JSON Schema:',
    JSON.stringify(responseSchema),
    transport === 'provider'
      ? 'Do not add text outside the configured structured response.'
      : 'Do not wrap the JSON in Markdown or add text outside the structured-output call.',
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
    throw new DeepAgentStructuredOutputError(
      'DeepAgents structured output returned invalid JSON.',
      json,
    );
  }

  const validate = new Ajv({
    addUsedSchema: false,
    allErrors: true,
    strict: false,
  }).compile(responseSchema as AnySchema);
  if (!validate(parsed)) {
    const detail = validate.errors
      ?.slice(0, 5)
      .map(
        (error) =>
          `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
      )
      .join('; ');
    throw new DeepAgentStructuredOutputError(
      `DeepAgents structured output failed response_schema validation${detail ? `: ${detail}` : '.'}`,
      json,
    );
  }
  return JSON.stringify(parsed);
}

function envelopeJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeepAgentStructuredOutputError(
      'DeepAgents structured output did not return a response.',
    );
  }
  const json = (value as Record<string, unknown>).json;
  if (typeof json !== 'string' || !json.trim()) {
    throw new DeepAgentStructuredOutputError(
      'DeepAgents structured output did not return JSON.',
    );
  }
  return json;
}
