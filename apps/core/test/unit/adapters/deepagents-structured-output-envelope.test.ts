import { describe, expect, it } from 'vitest';

import {
  appendStructuredOutputContract,
  serializeValidatedStructuredOutput,
  STRUCTURED_OUTPUT_ENVELOPE_SCHEMA,
} from '../../../src/adapters/llm/deepagents-langchain/runner/structured-output-envelope.js';

const schema = {
  type: 'object',
  properties: { version: { const: 1 }, status: { enum: ['ok'] } },
  required: ['version', 'status'],
  additionalProperties: false,
} as const;

describe('DeepAgents structured-output envelope', () => {
  it('keeps provider transport small and puts the authoritative schema in the prompt', () => {
    expect(STRUCTURED_OUTPUT_ENVELOPE_SCHEMA.properties).toEqual({
      json: expect.objectContaining({ type: 'string' }),
    });
    const prompt = appendStructuredOutputContract('base', schema);
    expect(prompt).toContain('base');
    expect(prompt).toContain(JSON.stringify(schema));
  });

  it('unwraps and validates JSON before returning it to Gantry', () => {
    expect(
      serializeValidatedStructuredOutput(
        { json: JSON.stringify({ version: 1, status: 'ok' }) },
        schema,
      ),
    ).toBe('{"version":1,"status":"ok"}');
    expect(() =>
      serializeValidatedStructuredOutput(
        { json: JSON.stringify({ version: 1, status: 'wrong' }) },
        schema,
      ),
    ).toThrow('response_schema validation');
  });
});
