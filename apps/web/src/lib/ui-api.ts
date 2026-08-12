import { queryOptions } from '@tanstack/react-query';

const CONNECTION_REFRESH_MS = 30_000;
const CONNECTION_ERROR_REFRESH_MS = 5 * 60 * 1000;

export type UiConnection = {
  status: string;
  processRole: string;
  features: Record<'sessions' | 'jobs' | 'events' | 'webhooks', boolean>;
};

export type UiAgent = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export class UiApiError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(code);
  }
}

export const connectionQuery = queryOptions({
  queryKey: ['ui-api', 'connection'],
  queryFn: ({ signal }) => getConnection(signal),
  refetchInterval: (query) =>
    query.state.status === 'error'
      ? CONNECTION_ERROR_REFRESH_MS
      : CONNECTION_REFRESH_MS,
  staleTime: CONNECTION_REFRESH_MS,
});

export const agentsQuery = queryOptions({
  queryKey: ['ui-api', 'agents'],
  queryFn: ({ signal }) => getAgents(signal),
  refetchOnMount: 'always',
  staleTime: Number.POSITIVE_INFINITY,
});

export function getConnection(signal?: AbortSignal) {
  return get<UiConnection>('/ui/api/connection', signal);
}

export function getAgents(signal?: AbortSignal) {
  return get<{ agents: UiAgent[] }>('/ui/api/agents', signal);
}

export function uiApiErrorMessage(error: unknown): string {
  if (!(error instanceof UiApiError)) return 'The UI API did not respond.';
  if (error.code === 'UI_NOT_CONFIGURED') {
    return 'The UI server is not configured to reach this Gantry deployment.';
  }
  if (error.code === 'CONTROL_API_UNAVAILABLE') {
    return 'The Gantry Control API is unavailable.';
  }
  return 'The UI API could not load this data.';
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UiApiError('UI_API_UNAVAILABLE', true);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new UiApiError('INVALID_UI_API_RESPONSE', response.status >= 500);
  }

  if (!response.ok) {
    const failure = readFailure(body);
    throw new UiApiError(failure.code, failure.retryable, failure.requestId);
  }

  return body as T;
}

function readFailure(body: unknown): {
  code: string;
  retryable: boolean;
  requestId?: string;
} {
  if (!body || typeof body !== 'object' || !('error' in body)) {
    return { code: 'UI_API_ERROR', retryable: false };
  }
  const error = body.error;
  if (!error || typeof error !== 'object') {
    return { code: 'UI_API_ERROR', retryable: false };
  }
  return {
    code:
      'code' in error && typeof error.code === 'string'
        ? error.code
        : 'UI_API_ERROR',
    retryable:
      'retryable' in error && typeof error.retryable === 'boolean'
        ? error.retryable
        : false,
    requestId:
      'requestId' in error && typeof error.requestId === 'string'
        ? error.requestId
        : undefined,
  };
}
