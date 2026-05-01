import {
  resolveModelSelection,
  resolveRunnerModel,
} from '../shared/model-catalog.js';

export const CLAUDE_MODEL_PINS = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
} as const;

export const CLAUDE_CODE_MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'opusplan',
  'sonnet[1m]',
  'opus[1m]',
] as const;

export const CLAUDE_CODE_PINNED_MODELS = [] as readonly string[];

export const CLAUDE_CODE_ALLOWED_MODELS = [
  ...CLAUDE_CODE_MODEL_ALIASES,
  ...CLAUDE_CODE_PINNED_MODELS,
] as const;

export const DEFAULT_SETUP_MODEL = 'opus';

export const MEMORY_MODEL_DEFAULTS = {
  extractor: CLAUDE_MODEL_PINS.haiku,
  dreaming: CLAUDE_MODEL_PINS.sonnet,
  consolidation: CLAUDE_MODEL_PINS.sonnet,
} as const;

export const CLAUDE_CODE_MODEL_PIN_ENV = {};

export const CLAUDE_CODE_MODEL_PIN_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

export function normalizeClaudeModelSelection(
  value?: string | null,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const runnerModel = resolveRunnerModel(trimmed);
  if (runnerModel) return runnerModel;

  const allowedAlias = CLAUDE_CODE_MODEL_ALIASES.find(
    (alias) => alias.toLowerCase() === trimmed.toLowerCase(),
  );
  if (allowedAlias) return allowedAlias;

  return undefined;
}

export function normalizeSupportedModelAlias(
  value?: string | null,
): string | undefined {
  const resolved = resolveModelSelection(value);
  return resolved.ok ? resolved.alias : undefined;
}
