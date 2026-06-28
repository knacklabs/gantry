import { describe, expect, it } from 'vitest';

import { resolveThinkingOptions } from '@core/adapters/llm/anthropic-claude-agent/runner/model-config.js';

describe('Anthropic Claude Agent model config', () => {
  it('omits thinking display by default while keeping adaptive effort', () => {
    expect(resolveThinkingOptions()).toMatchObject({
      thinking: { type: 'adaptive', display: 'omitted' },
      effort: 'medium',
    });
  });

  it('omits enabled/adaptive thinking unless the caller explicitly chooses a display mode', () => {
    expect(resolveThinkingOptions({ mode: 'enabled' }).thinking).toMatchObject({
      type: 'enabled',
      display: 'omitted',
    });
    expect(
      resolveThinkingOptions({ mode: 'adaptive', display: 'summarized' })
        .thinking,
    ).toMatchObject({
      type: 'adaptive',
      display: 'summarized',
    });
  });

  it('does not attach display to disabled thinking', () => {
    expect(resolveThinkingOptions({ mode: 'disabled' }).thinking).toEqual({
      type: 'disabled',
    });
  });
});
