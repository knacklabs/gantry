import { createHash } from 'crypto';

import type { ModelCatalogEntry } from '../../../shared/model-catalog.js';
import { resolveModelCacheSupport } from '../../../shared/model-cache-support.js';
import type { CachePromptControlMode } from './runner/cache-control.js';

export function resolveDeepAgentsPromptCache(input: {
  modelEntry: ModelCatalogEntry;
  conversationId: string;
  threadId?: string;
  accessFingerprint?: string;
}): {
  cacheMode: CachePromptControlMode;
  promptCacheKey?: string;
} {
  const promptSupport = resolveModelCacheSupport(input.modelEntry).prompt;
  const cacheMode = cachePromptControlMode(promptSupport.requestControl);
  return {
    cacheMode,
    ...(promptSupport.promptCacheKey
      ? {
          promptCacheKey: createHash('sha256')
            .update('gantry-deepagents-prompt-cache-key\0')
            .update(input.conversationId)
            .update('\0')
            .update(input.threadId ?? '')
            .update('\0')
            .update(input.accessFingerprint ?? '')
            .digest('hex'),
        }
      : {}),
  };
}

function cachePromptControlMode(
  requestControl: 'none' | 'cache_control_blocks' | 'provider_automatic_prefix',
): CachePromptControlMode {
  switch (requestControl) {
    case 'provider_automatic_prefix':
      return 'automatic';
    case 'cache_control_blocks':
      return 'explicit';
    default:
      return 'none';
  }
}
