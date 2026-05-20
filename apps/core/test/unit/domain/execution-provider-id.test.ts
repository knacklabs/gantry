import { describe, expect, it } from 'vitest';

import {
  assertSafeExecutionProviderId,
  isSafeExecutionProviderId,
} from '@core/domain/sessions/execution-provider-id.js';

describe('execution provider id validation', () => {
  it.each([
    'anthropic:claude-agent-sdk',
    'openrouter:kimi.k2',
    'a:b',
    'A0._-:B0._-',
  ])('accepts %s', (value) => {
    expect(isSafeExecutionProviderId(value)).toBe(true);
    expect(() => assertSafeExecutionProviderId(value)).not.toThrow();
  });

  it.each([
    '',
    'anthropic',
    ':claude',
    'anthropic:',
    'anthropic::claude',
    'anthropic/claude:runner',
    'anthropic:claude/runner',
    '-anthropic:claude',
    'anthropic:-claude',
    ' anthropic:claude',
    'anthropic:claude ',
  ])('rejects %s', (value) => {
    expect(isSafeExecutionProviderId(value)).toBe(false);
    expect(() => assertSafeExecutionProviderId(value)).toThrow(
      'Invalid execution provider id',
    );
  });
});
