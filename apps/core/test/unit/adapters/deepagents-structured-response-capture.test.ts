import { describe, expect, it } from 'vitest';
import {
  structuredResponseFromEventOutput,
  structuredResponseFromFinalText,
  structuredResponseFromModelEventOutput,
} from '../../../src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js';

describe('structuredResponseFromEventOutput', () => {
  it('reads root and nested LangGraph structured responses', () => {
    expect(
      structuredResponseFromEventOutput({ structuredResponse: { json: '{}' } }),
    ).toEqual({ json: '{}' });
    expect(
      structuredResponseFromEventOutput({
        model: { structuredResponse: { json: '{"status":"complete"}' } },
      }),
    ).toEqual({ json: '{"status":"complete"}' });
    expect(
      structuredResponseFromEventOutput({
        graph: {
          nodes: [
            {
              output: { structuredResponse: { json: '{"status":"complete"}' } },
            },
          ],
        },
      }),
    ).toEqual({ json: '{"status":"complete"}' });
    expect(
      structuredResponseFromEventOutput({
        chunk: { structuredResponse: { json: '{"status":"complete"}' } },
      }),
    ).toEqual({ json: '{"status":"complete"}' });
  });

  it('accepts only pure JSON final text as a structured-response fallback', () => {
    expect(structuredResponseFromFinalText('{"status":"complete"}')).toEqual({
      json: '{"status":"complete"}',
    });
    expect(
      structuredResponseFromFinalText(
        '{"json":"{\\"status\\":\\"complete\\"}"}',
      ),
    ).toEqual({
      json: '{"status":"complete"}',
    });
    expect(
      structuredResponseFromFinalText('```json\n{"status":"complete"}\n```'),
    ).toEqual({
      json: '{"status":"complete"}',
    });
    expect(
      structuredResponseFromFinalText('Done: {"status":"complete"}'),
    ).toBeUndefined();
    expect(
      structuredResponseFromFinalText(
        'Done\n```json\n{"status":"complete"}\n```',
      ),
    ).toBeUndefined();
  });
});

describe('structuredResponseFromModelEventOutput', () => {
  it('reads only exact JSON from a streamed model message', () => {
    expect(
      structuredResponseFromModelEventOutput({
        generations: [
          [
            {
              message: { content: '{"json":"{\\"status\\":\\"complete\\"}"}' },
            },
          ],
        ],
      }),
    ).toEqual({ json: '{"status":"complete"}' });
    expect(
      structuredResponseFromModelEventOutput({
        message: { content: 'Done: {"status":"complete"}' },
      }),
    ).toBeUndefined();
  });
});
