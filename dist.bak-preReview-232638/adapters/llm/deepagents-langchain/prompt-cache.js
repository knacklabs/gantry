import { createHash } from 'crypto';
import { resolveModelCacheSupport } from '../../../shared/model-cache-support.js';
export function resolveDeepAgentsPromptCache(input) {
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
function cachePromptControlMode(requestControl) {
    switch (requestControl) {
        case 'provider_automatic_prefix':
            return 'automatic';
        case 'cache_control_blocks':
            return 'explicit';
        default:
            return 'none';
    }
}
