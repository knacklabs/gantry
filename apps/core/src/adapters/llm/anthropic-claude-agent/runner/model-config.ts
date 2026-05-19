import type {
  EffortLevel,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { resolveCatalogRunnerModel } from '../../../../shared/model-catalog.js';
import type { AgentRunnerInput } from './types.js';

function normalizeModelValue(value?: string): string | undefined {
  return resolveCatalogRunnerModel(value);
}

export function resolveConfiguredModel(): {
  model?: string;
  source: 'ANTHROPIC_MODEL' | 'unset';
} {
  const anthropicModel = normalizeModelValue(process.env.ANTHROPIC_MODEL);
  if (anthropicModel) {
    return { model: anthropicModel, source: 'ANTHROPIC_MODEL' };
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
      thinking: { type: 'adaptive' },
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
        display: thinkingOverride.display,
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
      display: thinkingOverride.display,
    },
    effort: thinkingOverride.effort,
    description: thinkingOverride.effort
      ? `adaptive (effort ${thinkingOverride.effort})`
      : 'adaptive',
  };
}
