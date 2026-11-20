import { describe, it, expect } from 'vitest';
import { sourceChannelNativeControls } from '../../../src/adapters/llm/anthropic-claude-agent/runner/source-channel-model-controls.js';
describe('native source model controls', () => {
  it('sets the native SDK output cap and omits unsupported Haiku thinking/effort', () => {
    const controls = sourceChannelNativeControls('workspace-a', 2000);
    expect(controls?.env).toEqual({
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2000',
      MAX_THINKING_TOKENS: '0',
    });
    expect(controls?.effort).toBeUndefined();
    expect(controls?.thinking).toBeUndefined();
  });
  it('leaves other agents unchanged and rejects unbounded source execution', () => {
    expect(sourceChannelNativeControls(undefined, undefined)).toBeUndefined();
    expect(() => sourceChannelNativeControls('workspace-a', undefined)).toThrow(
      /bounded/,
    );
    expect(() => sourceChannelNativeControls('workspace-a', 64001)).toThrow(
      /bounded/,
    );
  });
});
