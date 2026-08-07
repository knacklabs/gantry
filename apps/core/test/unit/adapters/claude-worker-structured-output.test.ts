import { describe, expect, it } from 'vitest';

import {
  CompletionContinuationError,
  sdkResultFailureMetadata,
  sdkResultText,
  sdkStructuredOutputOptions,
  StructuredOutputValidationError,
} from '@core/adapters/llm/anthropic-claude-agent/runner/sdk-message-output.js';

describe('Claude worker structured output', () => {
  const schema = {
    type: 'object',
    properties: { recipeVersion: { type: 'string' } },
    required: ['recipeVersion'],
  };

  it('projects the schema into the SDK and returns only structured output', () => {
    expect(sdkStructuredOutputOptions(schema)).toEqual({
      outputFormat: { type: 'json_schema', schema },
    });
    expect(
      sdkResultText(
        {
          subtype: 'success',
          result: 'unvalidated narration',
          structured_output: { recipeVersion: '1.0.0' },
        },
        schema,
      ),
    ).toBe('{"recipeVersion":"1.0.0"}');
  });

  it('fails closed when the SDK omits validated structured output', () => {
    expect(() =>
      sdkResultText(
        { subtype: 'success', result: '{"recipeVersion":"invented"}' },
        schema,
      ),
    ).toThrow('without validated structured output');
  });

  it('validates SDK structured output with AJV instead of trusting the provider flag', () => {
    expect(() =>
      sdkResultText(
        {
          subtype: 'success',
          structured_output: { recipeVersion: 1 },
        },
        schema,
      ),
    ).toThrow('/recipeVersion must be string');
  });

  it('classifies only typed structured-output failures with a stable code', () => {
    for (const message of ['provider wording one', 'provider wording two']) {
      expect(
        sdkResultFailureMetadata(new StructuredOutputValidationError(message)),
      ).toEqual({
        type: 'execution',
        code: 'structured_output_validation_failed',
        attemptedAction: 'Validate final response against response schema',
      });
    }

    for (const message of [
      'structured output validation failed',
      'provider unavailable',
      'timed out',
      'cancelled',
    ]) {
      expect(sdkResultFailureMetadata(new Error(message))).toBeUndefined();
    }
  });

  it('classifies only typed completion-continuation failures with a stable code', () => {
    for (const message of ['provider wording one', 'provider wording two']) {
      expect(
        sdkResultFailureMetadata(new CompletionContinuationError(message)),
      ).toEqual({
        type: 'execution',
        code: 'completion_continuation_failed',
        attemptedAction: 'Continue after completion gate requested more work',
      });
    }

    expect(
      sdkResultFailureMetadata(new Error('completion continuation failed')),
    ).toBeUndefined();
  });
});
