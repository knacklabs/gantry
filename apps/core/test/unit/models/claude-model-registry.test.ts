import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MODEL_PINS,
  normalizeClaudeModelSelection,
  normalizeSupportedModelAlias,
} from '@core/models/claude-model-registry.js';
import { resolveModelSelection } from '@core/shared/model-catalog.js';

describe('normalizeClaudeModelSelection', () => {
  it('resolves supported catalog aliases to runner model IDs', () => {
    expect(normalizeClaudeModelSelection('opus')).toBe(CLAUDE_MODEL_PINS.opus);
    expect(normalizeClaudeModelSelection(' sonnet ')).toBe(
      CLAUDE_MODEL_PINS.sonnet,
    );
    expect(normalizeClaudeModelSelection('OpusPlan')).toBe('opusplan');
  });

  it('normalizes common human shorthand to safe Claude selections', () => {
    expect(normalizeClaudeModelSelection('opus-4-7')).toBe(
      CLAUDE_MODEL_PINS.opus,
    );
    expect(normalizeClaudeModelSelection('opus 4.7')).toBe(
      CLAUDE_MODEL_PINS.opus,
    );
    expect(normalizeClaudeModelSelection('opus-4-6')).toBe('claude-opus-4-6');
    expect(normalizeClaudeModelSelection('sonnet-4-6')).toBe(
      CLAUDE_MODEL_PINS.sonnet,
    );
    expect(normalizeClaudeModelSelection('haiku-4-5')).toBe(
      CLAUDE_MODEL_PINS.haiku,
    );
  });

  it('rejects unknown and raw provider model IDs before runtime validation', () => {
    expect(
      normalizeClaudeModelSelection('custom-provider-model'),
    ).toBeUndefined();
    expect(normalizeClaudeModelSelection('claude-opus-4-7')).toBeUndefined();
  });

  it('returns friendly aliases and suggestions from the catalog resolver', () => {
    expect(normalizeSupportedModelAlias('kimi 2.6')).toBe('kimi');

    const resolved = resolveModelSelection('sonet');
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'unknown',
      suggestion: 'sonnet',
    });
  });
});
