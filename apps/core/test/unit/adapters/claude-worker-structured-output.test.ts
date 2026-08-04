import { describe, expect, it } from 'vitest';

import {
  sdkResultText,
  sdkStructuredOutputOptions,
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
});
