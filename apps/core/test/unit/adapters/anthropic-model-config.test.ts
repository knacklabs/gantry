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

  it('raises sub-minimum thinking budgets to the API floor and drops invalid ones', () => {
    expect(
      resolveThinkingOptions({ mode: 'enabled', budgetTokens: 128 }).thinking,
    ).toMatchObject({ type: 'enabled', budgetTokens: 1024 });
    expect(
      resolveThinkingOptions({ mode: 'enabled', budgetTokens: 4096.7 })
        .thinking,
    ).toMatchObject({ type: 'enabled', budgetTokens: 4096 });
    expect(
      resolveThinkingOptions({ mode: 'enabled', budgetTokens: Number.NaN })
        .thinking,
    ).toMatchObject({ type: 'enabled', budgetTokens: undefined });
  });

  it('maps configured effort and thinking defaults into SDK options', () => {
    expect(resolveThinkingOptions(undefined, undefined, 'high')).toMatchObject({
      thinking: { type: 'adaptive' },
      effort: 'high',
    });
    expect(resolveThinkingOptions(undefined, { mode: 'off' })).toMatchObject({
      thinking: { type: 'disabled' },
    });
    expect(
      resolveThinkingOptions(undefined, { mode: 'on', budgetTokens: 4096 }),
    ).toMatchObject({
      thinking: { type: 'enabled', budgetTokens: 4096 },
    });
    expect(
      resolveThinkingOptions(undefined, { mode: 'on', budgetTokens: 1 }),
    ).toMatchObject({
      thinking: { type: 'enabled', budgetTokens: 1024 },
    });
    expect(resolveThinkingOptions(undefined, { mode: 'on' })).toMatchObject({
      thinking: { type: 'adaptive' },
    });
  });

  it('keeps the conversation thinking override authoritative over configured defaults', () => {
    expect(
      resolveThinkingOptions(
        { mode: 'adaptive', effort: 'low' },
        { mode: 'off' },
        'high',
      ),
    ).toMatchObject({
      thinking: { type: 'adaptive' },
      effort: 'low',
    });
  });
});
