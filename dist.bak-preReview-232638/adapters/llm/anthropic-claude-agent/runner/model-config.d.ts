import type { EffortLevel, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunnerInput } from './types.js';
export declare function resolveConfiguredModel(): {
    model?: string;
    source: 'ANTHROPIC_MODEL' | 'unset';
};
export declare function resolveThinkingOptions(thinkingOverride?: AgentRunnerInput['thinking'], configuredThinking?: AgentRunnerInput['configuredThinking'], configuredEffort?: AgentRunnerInput['effort']): {
    thinking?: ThinkingConfig;
    effort?: EffortLevel;
    description: string;
};
export declare function resolveConfiguredAgentControlOptions(configuredThinking?: AgentRunnerInput['configuredThinking'], configuredEffort?: AgentRunnerInput['effort']): {
    thinking?: ThinkingConfig;
    effort?: EffortLevel;
};
