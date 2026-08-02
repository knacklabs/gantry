import { findModelByRunnerModel, resolveRunnerModel, } from '../../../../shared/model-catalog.js';
const GANTRY_EFFECTIVE_MODEL_SOURCE_ENV = 'GANTRY_EFFECTIVE_MODEL_SOURCE';
const DEFAULT_THINKING_DISPLAY = 'omitted';
// Anthropic API minimum for thinking.budget_tokens.
const MIN_THINKING_BUDGET_TOKENS = 1024;
function normalizeModelValue(value) {
    const aliasModel = resolveRunnerModel(value);
    if (aliasModel)
        return aliasModel;
    if (process.env[GANTRY_EFFECTIVE_MODEL_SOURCE_ENV] === 'runtime') {
        return findModelByRunnerModel(value)?.runnerModel;
    }
    return undefined;
}
export function resolveConfiguredModel() {
    const configuredModel = normalizeModelValue(process.env.ANTHROPIC_MODEL);
    if (configuredModel) {
        return { model: configuredModel, source: 'ANTHROPIC_MODEL' };
    }
    return { source: 'unset' };
}
export function resolveThinkingOptions(thinkingOverride, configuredThinking, configuredEffort) {
    if (!thinkingOverride && !configuredThinking && !configuredEffort) {
        return {
            thinking: { type: 'adaptive', display: DEFAULT_THINKING_DISPLAY },
            effort: 'medium',
            description: 'adaptive (effort medium)',
        };
    }
    if (!thinkingOverride) {
        const configured = resolveConfiguredAgentControlOptions(configuredThinking, configuredEffort);
        const merged = {
            thinking: configured.thinking ??
                { type: 'adaptive', display: DEFAULT_THINKING_DISPLAY },
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
            description: typeof validBudget === 'number'
                ? `enabled (budget ${validBudget} tokens${validBudget !== rawBudget ? `, raised from ${rawBudget}` : ''})`
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
export function resolveConfiguredAgentControlOptions(configuredThinking, configuredEffort) {
    const thinking = configuredThinking
        ? configuredThinking.mode === 'off'
            ? { type: 'disabled' }
            : configuredThinking.budgetTokens === undefined
                ? { type: 'adaptive', display: DEFAULT_THINKING_DISPLAY }
                : {
                    type: 'enabled',
                    budgetTokens: normalizeThinkingBudgetTokens(configuredThinking.budgetTokens),
                    display: DEFAULT_THINKING_DISPLAY,
                }
        : undefined;
    return {
        ...(thinking ? { thinking } : {}),
        ...(configuredEffort ? { effort: configuredEffort } : {}),
    };
}
function normalizeThinkingBudgetTokens(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(Math.floor(value), MIN_THINKING_BUDGET_TOKENS)
        : undefined;
}
function describeThinkingOptions(options) {
    if (!options.thinking)
        return `adaptive (effort ${options.effort})`;
    if (options.thinking.type === 'disabled')
        return 'disabled';
    if (options.thinking.type === 'enabled') {
        return options.thinking.budgetTokens === undefined
            ? 'enabled'
            : `enabled (budget ${options.thinking.budgetTokens} tokens)`;
    }
    return options.effort ? `adaptive (effort ${options.effort})` : 'adaptive';
}
