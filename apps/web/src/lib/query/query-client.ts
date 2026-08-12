import { QueryClient } from '@tanstack/react-query';

import { UiApiError } from '../ui-api';

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
      retry: (failureCount, error) =>
        error instanceof UiApiError && error.retryable && failureCount < 2,
      retryDelay: (attempt) =>
        Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS),
    },
  },
});
