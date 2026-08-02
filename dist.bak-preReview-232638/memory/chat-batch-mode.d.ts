import type { ModelProviderDefinition } from '../shared/model-provider-registry.js';
export declare const CHAT_BATCH_PROVIDER_MIN_ITEMS = 100;
export type ChatBatchMode = 'auto' | 'inline' | 'provider_batch';
export type ResolvedChatBatchMode = 'inline' | 'provider_batch';
export declare function supportsChatBatch(provider: Pick<ModelProviderDefinition, 'batch'>): boolean;
export declare function resolveChatBatchMode(input: {
    enabled?: boolean;
    mode: ChatBatchMode;
    itemCount: number;
    provider: Pick<ModelProviderDefinition, 'batch'>;
    minItems?: number;
}): ResolvedChatBatchMode;
