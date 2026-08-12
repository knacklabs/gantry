import { queryOptions } from '@tanstack/react-query';

const CONNECTION_REFRESH_MS = 30_000;
const CONNECTION_ERROR_REFRESH_MS = 5 * 60 * 1000;
const OVERVIEW_REFRESH_MS = 30_000;
const INSTANCES_REFRESH_MS = 60_000;
const METRICS_REFRESH_MS = 5 * 60_000;
const ACTIVITY_REFRESH_MS = 30_000;

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

export type UiReadiness = {
  status: 'ready' | 'degraded';
  failing: string[];
  checks: Record<string, string | boolean>;
};

export type UiRuntimeSummary = {
  role: 'all' | 'control' | 'live-worker' | 'job-worker';
  status: 'ready' | 'degraded';
  uptimeSeconds: number;
  capacity: { liveLimit: number; jobLimit: number | null };
  counts: {
    instances: number;
    liveWorkers: number;
    jobWorkers: number;
    stale: number;
  };
  readiness: UiReadiness;
};

export type UiInstance = {
  id: string;
  role: UiRuntimeSummary['role'];
  status: string;
  heartbeat: {
    status: 'fresh' | 'stale' | 'not-applicable';
    at: string | null;
  };
  readiness: UiReadiness | null;
  capacity: UiRuntimeSummary['capacity'] | null;
  capabilities: string[];
  startedAt: string;
  lastSeenAt: string;
};

export type UiOverview = {
  deployment: UiRuntimeSummary | null;
  instanceCounts: UiRuntimeSummary['counts'] | null;
  agentCounts: { total: number; active: number; disabled: number } | null;
  unavailable: Array<'runtime' | 'agents'>;
  attention: { status: 'ready' | 'attention'; label: string; to: '/instances' };
};

export type UiMetricRange = '24h' | '7d' | '30d';
export type UiMetricUsage = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
};
export type UiMetrics = {
  range: UiMetricRange;
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  usage: {
    totals: UiMetricUsage;
    buckets: Array<UiMetricUsage & { start: string }>;
    models: Array<UiMetricUsage & { model: string }>;
  };
  runs: {
    total: number;
    statuses: Array<{
      status: 'completed' | 'failed' | 'canceled';
      count: number;
    }>;
    p95DurationMs?: number;
  };
};

export type UiActivityRun = {
  id: string;
  agentId: string;
  cause: 'message' | 'job' | 'control' | 'manual' | 'system';
  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'canceled'
    | 'timeout';
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  errorSummary: string | null;
};

export type UiActivityTask = {
  id: string;
  agentId: string;
  targetAgentId: string | null;
  kind:
    | 'async_command'
    | 'delegated_agent'
    | 'mcp_tool_call'
    | 'session_compaction';
  status:
    | 'queued'
    | 'running'
    | 'needs_attention'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'timed_out';
  summary: string | null;
  outputSummary: string | null;
  errorSummary: string | null;
  currentPhase: string | null;
  lastProgress: string | null;
  lastToolSummary: string | null;
  blocker: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  terminalAt: string | null;
  durationMs: number | null;
  children: UiActivityTask[];
};

export type UiActivityDetail = {
  run: UiActivityRun;
  tasks: UiActivityTask[];
  taskTotal: number;
  truncated: boolean;
};

export type UiAgentSummary = { agent: UiAgent; boundConversationCount: number };
export type UiAgentRelation =
  | {
      configured: string[];
      resolved: Array<{
        ref: string;
        agentId: string;
        displayName: string;
        persona: string;
      }>;
    }
  | {
      skills: Array<{
        id: string;
        skillId: string;
        status: string;
        updatedAt: string;
      }>;
    }
  | { capabilities: Array<{ id: string; version: string }> }
  | {
      updatedAt: string;
      summary: Record<
        'connected' | 'allowed' | 'needsAttention' | 'suggestedCleanup',
        Array<{ label: string; detail: string }>
      >;
    }
  | {
      activity: Array<{
        id: string;
        name: string;
        kind: string;
        status: string;
        lastRun: string | null;
        nextRun: string | null;
      }>;
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

export const overviewQuery = queryOptions({
  queryKey: ['ui-api', 'overview'],
  queryFn: ({ signal }) => get<UiOverview>('/ui/api/overview', signal),
  refetchInterval: () =>
    document.visibilityState === 'visible' ? OVERVIEW_REFRESH_MS : false,
  staleTime: OVERVIEW_REFRESH_MS,
});

export const instancesQuery = queryOptions({
  queryKey: ['ui-api', 'instances'],
  queryFn: ({ signal }) =>
    get<{ instances: UiInstance[] }>('/ui/api/instances', signal),
  refetchInterval: () =>
    document.visibilityState === 'visible' ? INSTANCES_REFRESH_MS : false,
  staleTime: INSTANCES_REFRESH_MS,
});

export function metricsQuery(range: UiMetricRange) {
  return queryOptions({
    queryKey: ['ui-api', 'metrics', range],
    queryFn: ({ signal }) =>
      get<UiMetrics>(`/ui/api/metrics?range=${range}`, signal),
    refetchInterval: () =>
      document.visibilityState === 'visible' ? METRICS_REFRESH_MS : false,
    staleTime: METRICS_REFRESH_MS,
  });
}

export const activityQuery = queryOptions({
  queryKey: ['ui-api', 'activity'],
  queryFn: ({ signal }) =>
    get<{ runs: UiActivityRun[] }>('/ui/api/activity', signal),
  refetchInterval: () =>
    document.visibilityState === 'visible' ? ACTIVITY_REFRESH_MS : false,
  staleTime: ACTIVITY_REFRESH_MS,
});

export function activityDetailQuery(runId: string) {
  return queryOptions({
    queryKey: ['ui-api', 'activity', runId],
    queryFn: ({ signal }) =>
      get<UiActivityDetail>(
        `/ui/api/activity/${encodeURIComponent(runId)}`,
        signal,
      ),
    refetchInterval: (query) =>
      document.visibilityState === 'visible' &&
      query.state.data &&
      !isTerminalActivityStatus(query.state.data.run.status)
        ? ACTIVITY_REFRESH_MS
        : false,
    staleTime: ACTIVITY_REFRESH_MS,
  });
}

export function isTerminalActivityStatus(status: string) {
  return ['completed', 'failed', 'canceled', 'timeout'].includes(status);
}

export function instanceQuery(instanceId: string) {
  return queryOptions({
    queryKey: ['ui-api', 'instances', instanceId],
    queryFn: ({ signal }) =>
      get<{ instance: UiInstance }>(
        `/ui/api/instances/${encodeURIComponent(instanceId)}`,
        signal,
      ),
    staleTime: INSTANCES_REFRESH_MS,
  });
}

export function agentSummaryQuery(agentId: string) {
  return queryOptions({
    queryKey: ['ui-api', 'agents', agentId],
    queryFn: ({ signal }) =>
      get<UiAgentSummary>(
        `/ui/api/agents/${encodeURIComponent(agentId)}`,
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function agentRelationQuery(
  agentId: string,
  relation: 'delegation' | 'skills' | 'capabilities' | 'access' | 'activity',
) {
  return queryOptions({
    queryKey: ['ui-api', 'agents', agentId, relation],
    queryFn: ({ signal }) =>
      get<UiAgentRelation>(
        `/ui/api/agents/${encodeURIComponent(agentId)}/${relation}`,
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

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
  if (error.code === 'RUN_NOT_FOUND') return 'This run no longer exists.';
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
