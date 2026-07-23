import type { ModelProviderDefinition } from '../shared/model-provider-registry.js';

export const CHAT_BATCH_PROVIDER_MIN_ITEMS = 100;

export type ChatBatchMode = 'auto' | 'inline' | 'provider_batch';
export type ResolvedChatBatchMode = 'inline' | 'provider_batch';

export function supportsChatBatch(
  provider: Pick<ModelProviderDefinition, 'batch'>,
): boolean {
  return Boolean(provider.batch);
}

export function resolveChatBatchMode(input: {
  enabled?: boolean;
  mode: ChatBatchMode;
  itemCount: number;
  provider: Pick<ModelProviderDefinition, 'batch'>;
  minItems?: number;
}): ResolvedChatBatchMode {
  if (!input.enabled || input.mode === 'inline') return 'inline';
  if (!supportsChatBatch(input.provider)) return 'inline';
  if (input.mode === 'provider_batch') return 'provider_batch';
  const minItems = Math.max(
    1,
    Math.floor(input.minItems ?? CHAT_BATCH_PROVIDER_MIN_ITEMS),
  );
  return input.itemCount >= minItems ? 'provider_batch' : 'inline';
}
