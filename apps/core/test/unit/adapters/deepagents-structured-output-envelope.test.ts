import { describe, expect, it } from 'vitest';

import {
  appendStructuredOutputContract,
  DeepAgentStructuredOutputError,
  preserveOriginalTaskPrompt,
  serializeValidatedStructuredOutput,
  structuredOutputContinuationPrompt,
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
    expect(
      appendStructuredOutputContract('base', schema, 'provider'),
    ).toContain('configured structured-output response');
  });

  it('unwraps and validates JSON before returning it to Gantry', () => {
    expect(
      serializeValidatedStructuredOutput(
        { json: JSON.stringify({ version: 1, status: 'ok' }) },
        schema,
      ),
    ).toBe('{"version":1,"status":"ok"}');
    let failure: unknown;
    try {
      serializeValidatedStructuredOutput(
        { json: JSON.stringify({ version: 1, status: 'wrong' }) },
        schema,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeepAgentStructuredOutputError);
    expect(failure).toMatchObject({
      message: expect.stringContaining('response_schema validation'),
      attemptedJson: '{"version":1,"status":"wrong"}',
    });
    expect(
      structuredOutputContinuationPrompt(
        failure as DeepAgentStructuredOutputError,
        'Continue from the checkpoint.',
      ),
    ).toContain('Continue the workflow');
  });

  it('retains immutable task context when a fresh DeepAgents turn continues', () => {
    const prompt = preserveOriginalTaskPrompt(
      'INPUT_JSON {"requestId":"request-1","attemptId":"attempt-1"}',
      'The completion owner requested more work.',
    );

    expect(prompt).toContain('"requestId":"request-1"');
    expect(prompt).toContain('"attemptId":"attempt-1"');
    expect(prompt).toContain('RUNTIME_CONTINUATION');
    expect(prompt).toContain('requested more work');
  });
});
