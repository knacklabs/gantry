import {
  AsyncCaller,
  type FailedAttemptHandler,
} from '@langchain/core/utils/async_caller';
import { classifyProviderBillingFailure } from '../../../../shared/provider-billing.js';
/** Delegate every ordinary failure to the installed library's unchanged retry policy. */
class DefaultTransportFailurePolicy extends AsyncCaller {
  handle(error: Error) {
    return this.onFailedAttempt?.(error);
  }
}
const defaultPolicy = new DefaultTransportFailurePolicy({});
export function sourceProviderFailedAttempt(
  provider: string,
): FailedAttemptHandler {
  return async (error) => {
    const failure = classifyProviderBillingFailure(provider, error);
    if (failure)
      throw new Error(
        `Source provider billing unavailable: ${failure.provider}/${failure.code}`,
      );
    await defaultPolicy.handle(error);
  };
}
