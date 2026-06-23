import { describe, expect, it } from 'vitest';

import { usageEventIdForMessage } from '@core/adapters/llm/anthropic-claude-agent/runner/query-usage-event-id.js';
import {
  assistantOutputText,
  selectToolUsePreamble,
} from '@core/adapters/llm/anthropic-claude-agent/runner/assistant-output.js';

describe('selectToolUsePreamble (early progress message)', () => {
  it('uses the assistant message own text when text and tool_use are combined', () => {
    expect(
      selectToolUsePreamble(
        'Let me look that up for you.',
        'streamed-fallback',
      ),
    ).toBe('Let me look that up for you.');
  });

  it('falls back to the streamed text when the tool_use message has no own text (split delivery)', () => {
    // Regression: the SDK can split a turn into a text-only assistant message
    // followed by a tool_use-only message whose own text is empty. Without the
    // fallback the preamble is dropped from the early-send path and only
    // surfaces (late) batched with the final reply.
    expect(
      selectToolUsePreamble('', 'Let me look up your recent orders now.'),
    ).toBe('Let me look up your recent orders now.');
  });

  it('returns empty (nothing to send) when neither source has text', () => {
    expect(selectToolUsePreamble('   ', '')).toBe('');
  });
});

describe('assistantOutputText', () => {
  it('reads text blocks from the top-level content shape', () => {
    expect(
      assistantOutputText({
        content: [
          { type: 'text', text: 'Let me look ' },
          { type: 'text', text: 'that up.' },
        ],
      }),
    ).toBe('Let me look that up.');
  });

  it('reads text blocks from the nested message.content shape', () => {
    expect(
      assistantOutputText({
        message: { content: [{ type: 'text', text: 'one moment.' }] },
      }),
    ).toBe('one moment.');
  });

  it('ignores tool_use blocks and returns empty for a text-less tool_use message', () => {
    expect(
      assistantOutputText({
        content: [{ type: 'tool_use', name: 'get_recent_orders', input: {} }],
      }),
    ).toBe('');
  });
});

describe('Claude query loop usage event IDs', () => {
  it('uses stable provider IDs when present', () => {
    expect(
      usageEventIdForMessage({ request_id: 'req-1' }, 'session-1', 1, 'run-a'),
    ).toBe('req-1');
  });

  it('keeps fallback usage IDs unique across resumed query runs', () => {
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-a')).toBe(
      'session-1:run:run-a:result:1',
    );
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-b')).toBe(
      'session-1:run:run-b:result:1',
    );
  });
});
