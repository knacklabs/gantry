import type { ModelCatalogEntry } from '../../../shared/model-catalog.js';
import type { CachePromptControlMode } from './runner/cache-control.js';
export declare function resolveDeepAgentsPromptCache(input: {
    modelEntry: ModelCatalogEntry;
    conversationId: string;
    threadId?: string;
    accessFingerprint?: string;
}): {
    cacheMode: CachePromptControlMode;
    promptCacheKey?: string;
};
