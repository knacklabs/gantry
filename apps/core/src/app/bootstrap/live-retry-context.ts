import type { GroupMessageRunContext } from '../../runtime/group-queue-types.js';

export function projectLiveRetryContext(context?: GroupMessageRunContext) {
  return {
    finalRetry: context?.finalRetry === true,
    retryCount: context?.retryCount,
    maxRetries: context?.maxRetries,
  };
}
