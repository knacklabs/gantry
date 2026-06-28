import type {
  EffortLevel,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import {
  findModelByRunnerModel,
  resolveRunnerModel,
} from '../../../../shared/model-catalog.js';
import type { AgentRunnerInput } from './types.js';

const GANTRY_EFFECTIVE_MODEL_SOURCE_ENV = 'GANTRY_EFFECTIVE_MODEL_SOURCE';
const DEFAULT_THINKING_DISPLAY = 'omitted' as const;

function normalizeModelValue(value?: string): string | undefined {
  const aliasModel = resolveRunnerModel(value);
  if (aliasModel) return aliasModel;
  if (process.env[GANTRY_EFFECTIVE_MODEL_SOURCE_ENV] === 'runtime') {
    return findModelByRunnerModel(value)?.runnerModel;
  }
  return undefined;
}

export function resolveConfiguredModel(): {
  model?: string;
  source: 'ANTHROPIC_MODEL' | 'unset';
} {
  const configuredModel = normalizeModelValue(process.env.ANTHROPIC_MODEL);
  if (configuredModel) {
    return { model: configuredModel, source: 'ANTHROPIC_MODEL' };
  }
  return { source: 'unset' };
}

export function resolveThinkingOptions(
  thinkingOverride?: AgentRunnerInput['thinking'],
): {
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  description: string;
} {
  if (!thinkingOverride) {
    return {
      thinking: { type: 'adaptive', display: DEFAULT_THINKING_DISPLAY },
      effort: 'medium',
      description: 'adaptive (effort medium)',
    };
  }

  if (thinkingOverride.mode === 'disabled') {
    return {
      thinking: { type: 'disabled' },
      description: 'disabled',
    };
  }

  if (thinkingOverride.mode === 'enabled') {
    return {
      thinking: {
        type: 'enabled',
        budgetTokens: thinkingOverride.budgetTokens,
        display: thinkingOverride.display ?? DEFAULT_THINKING_DISPLAY,
      },
      description:
        typeof thinkingOverride.budgetTokens === 'number'
          ? `enabled (budget ${thinkingOverride.budgetTokens} tokens)`
          : 'enabled',
    };
  }

  return {
    thinking: {
      type: 'adaptive',
      display: thinkingOverride.display ?? DEFAULT_THINKING_DISPLAY,
    },
    effort: thinkingOverride.effort,
    description: thinkingOverride.effort
      ? `adaptive (effort ${thinkingOverride.effort})`
      : 'adaptive',
  };
}
