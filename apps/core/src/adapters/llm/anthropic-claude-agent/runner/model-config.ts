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
// Anthropic API minimum for thinking.budget_tokens.
const MIN_THINKING_BUDGET_TOKENS = 1024;

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
  configuredThinking?: AgentRunnerInput['configuredThinking'],
  configuredEffort?: AgentRunnerInput['effort'],
): {
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  description: string;
} {
  if (!thinkingOverride && !configuredThinking && !configuredEffort) {
    return {
      thinking: { type: 'adaptive', display: DEFAULT_THINKING_DISPLAY },
      effort: 'medium',
      description: 'adaptive (effort medium)',
    };
  }

  if (!thinkingOverride) {
    const configured = resolveConfiguredAgentControlOptions(
      configuredThinking,
      configuredEffort,
    );
    const merged = {
      thinking:
        configured.thinking ??
        ({ type: 'adaptive', display: DEFAULT_THINKING_DISPLAY } as const),
      ...configured,
    };
    return {
      ...merged,
      description: describeThinkingOptions(merged),
    };
  }

  if (thinkingOverride.mode === 'disabled') {
    return {
      thinking: { type: 'disabled' },
      description: 'disabled',
    };
  }

  if (thinkingOverride.mode === 'enabled') {
    // The API rejects budgets below its minimum; an unvalidated override
    // would only fail later at request time. Invalid values fall back to
    // the SDK default budget instead of being passed through.
    const rawBudget = thinkingOverride.budgetTokens;
    const validBudget = normalizeThinkingBudgetTokens(rawBudget);
    return {
      thinking: {
        type: 'enabled',
        budgetTokens: validBudget,
        display: thinkingOverride.display ?? DEFAULT_THINKING_DISPLAY,
      },
      description:
        typeof validBudget === 'number'
          ? `enabled (budget ${validBudget} tokens${
              validBudget !== rawBudget ? `, raised from ${rawBudget}` : ''
            })`
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

export function resolveConfiguredAgentControlOptions(
  configuredThinking?: AgentRunnerInput['configuredThinking'],
  configuredEffort?: AgentRunnerInput['effort'],
): { thinking?: ThinkingConfig; effort?: EffortLevel } {
  const thinking = configuredThinking
    ? configuredThinking.mode === 'off'
      ? ({ type: 'disabled' } as const)
      : configuredThinking.budgetTokens === undefined
        ? ({ type: 'adaptive', display: DEFAULT_THINKING_DISPLAY } as const)
        : ({
            type: 'enabled',
            budgetTokens: normalizeThinkingBudgetTokens(
              configuredThinking.budgetTokens,
            ),
            display: DEFAULT_THINKING_DISPLAY,
          } as const)
    : undefined;
  return {
    ...(thinking ? { thinking } : {}),
    ...(configuredEffort ? { effort: configuredEffort } : {}),
  };
}

function normalizeThinkingBudgetTokens(value?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(Math.floor(value), MIN_THINKING_BUDGET_TOKENS)
    : undefined;
}

function describeThinkingOptions(options: {
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}): string {
  if (!options.thinking) return `adaptive (effort ${options.effort})`;
  if (options.thinking.type === 'disabled') return 'disabled';
  if (options.thinking.type === 'enabled') {
    return options.thinking.budgetTokens === undefined
      ? 'enabled'
      : `enabled (budget ${options.thinking.budgetTokens} tokens)`;
  }
  return options.effort ? `adaptive (effort ${options.effort})` : 'adaptive';
}
