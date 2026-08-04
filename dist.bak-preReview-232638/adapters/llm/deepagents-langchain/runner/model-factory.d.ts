import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatOpenRouterInput } from '@langchain/openrouter';
import type { AgentControlEffort, AgentControlThinking } from '../../../../domain/types.js';
export type ModelEndpointFamily = 'openai' | 'openrouter';
export type OpenRouterProviderPreferences = NonNullable<ChatOpenRouterInput['provider']>;
export interface ResolvedRunnerModel {
    model: BaseChatModel;
    endpointFamily: ModelEndpointFamily;
    modelId: string;
}
export declare function buildRunnerModel(input: {
    provider: string;
    modelId: string;
    gatewayBaseUrl: string;
    gatewayToken: string;
    sessionId?: string;
    promptCacheKey?: string;
    maxInputTokens?: number;
    effort?: AgentControlEffort;
    configuredThinking?: AgentControlThinking;
    maxOutputTokens?: number;
    openRouterProviderRouting?: OpenRouterProviderPreferences;
}): Promise<ResolvedRunnerModel>;
