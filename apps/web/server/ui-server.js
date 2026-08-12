import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { createClient } from '@gantry/sdk';

const DEFAULT_PORT = 4173;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DIST = fileURLToPath(new URL('../dist', import.meta.url));
const METRICS_CACHE_TTL_MS = 5 * 60_000;
const METRICS_RANGES = new Set(['24h', '7d', '30d']);
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendFailure(response, code, retryable) {
  sendJson(response, 503, {
    error: { code, requestId: randomUUID(), retryable },
  });
}

function sendNotFound(response) {
  sendJson(response, 404, {
    error: { code: 'NOT_FOUND', requestId: randomUUID(), retryable: false },
  });
}

function projectReadiness(readiness) {
  return {
    status: readiness.status,
    failing: readiness.failing,
    checks: {
      database: readiness.checks.database,
      migrations: readiness.checks.migrations,
      settings: readiness.checks.settings,
      draining: readiness.checks.draining,
      ...(readiness.checks.scheduler === undefined
        ? {}
        : { scheduler: readiness.checks.scheduler }),
      ...(readiness.checks.liveCapacity === undefined
        ? {}
        : { liveCapacity: readiness.checks.liveCapacity }),
    },
  };
}

function projectRuntime(runtime) {
  return {
    role: runtime.role,
    status: runtime.status,
    uptimeSeconds: runtime.uptimeSeconds,
    capacity: {
      liveLimit: runtime.capacity.liveLimit,
      jobLimit: runtime.capacity.jobLimit,
    },
    counts: {
      instances: runtime.counts.instances,
      liveWorkers: runtime.counts.liveWorkers,
      jobWorkers: runtime.counts.jobWorkers,
      stale: runtime.counts.stale,
    },
    readiness: projectReadiness(runtime.readiness),
  };
}

function projectInstance(instance) {
  return {
    id: instance.id,
    role: instance.role,
    status: instance.status,
    heartbeat: {
      status: instance.heartbeat.status,
      at: instance.heartbeat.at,
    },
    readiness: instance.readiness ? projectReadiness(instance.readiness) : null,
    capacity: instance.capacity
      ? {
          liveLimit: instance.capacity.liveLimit,
          jobLimit: instance.capacity.jobLimit,
        }
      : null,
    capabilities: instance.capabilities.map(String),
    startedAt: instance.startedAt,
    lastSeenAt: instance.lastSeenAt,
  };
}

function projectAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function projectAccessEntry(entry) {
  return { label: entry.label, detail: entry.detail };
}

function projectMetricUsage(usage) {
  return {
    requestCount: usage.requestCount,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.estimatedCostUsd === undefined
      ? {}
      : { estimatedCostUsd: usage.estimatedCostUsd }),
  };
}

function projectMetrics(metrics) {
  return {
    range: metrics.range,
    from: metrics.from,
    to: metrics.to,
    bucket: metrics.bucket,
    usage: {
      totals: projectMetricUsage(metrics.usage.totals),
      buckets: metrics.usage.buckets.map((bucket) => ({
        start: bucket.start,
        ...projectMetricUsage(bucket),
      })),
      models: metrics.usage.models.map((model) => ({
        model: model.model,
        ...projectMetricUsage(model),
      })),
    },
    runs: {
      total: metrics.runs.total,
      statuses: metrics.runs.statuses.map(({ status, count }) => ({
        status,
        count,
      })),
      ...(metrics.runs.p95DurationMs === undefined
        ? {}
        : { p95DurationMs: metrics.runs.p95DurationMs }),
    },
  };
}

function projectActivityRun(run) {
  return {
    id: run.id,
    agentId: run.agentId,
    cause: run.cause,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    resultSummary: run.resultSummary,
    errorSummary: run.errorSummary,
  };
}

function projectActivityTask(task) {
  return {
    id: task.id,
    agentId: task.agentId,
    targetAgentId: task.targetAgentId,
    kind: task.kind,
    status: task.status,
    summary: task.summary,
    outputSummary: task.outputSummary,
    errorSummary: task.errorSummary,
    currentPhase: task.currentPhase,
    lastProgress: task.lastProgress,
    lastToolSummary: task.lastToolSummary,
    blocker: task.blocker,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    terminalAt: task.terminalAt,
    durationMs: task.durationMs,
    children: task.children.map(projectActivityTask),
  };
}

function projectActivityInvalidation(event) {
  return {
    eventId: event.eventId,
    type: event.type,
    createdAt: event.createdAt,
  };
}

function parseActivityCursor(url) {
  if ([...url.searchParams.keys()].some((key) => key !== 'afterEventId')) {
    return null;
  }
  const values = url.searchParams.getAll('afterEventId');
  if (values.length > 1) return null;
  const value = Number(values[0] ?? '0');
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function waitForDrainOrClose(response) {
  return new Promise((resolve) => {
    const done = () => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
  });
}

async function streamActivity(request, response, client, runId, url) {
  const afterEventId = parseActivityCursor(url);
  if (afterEventId === null) {
    sendJson(response, 400, {
      error: {
        code: 'INVALID_ACTIVITY_CURSOR',
        requestId: randomUUID(),
        retryable: false,
      },
    });
    return;
  }

  const controller = new globalThis.AbortController();
  let closed = request.destroyed || response.destroyed;
  const close = () => {
    closed = true;
    controller.abort();
  };
  request.once('aborted', close);
  response.once('close', close);

  try {
    if (closed) return;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for await (const event of client.activity.stream(runId, {
      afterEventId,
      signal: controller.signal,
    })) {
      if (closed) break;
      const data = JSON.stringify(projectActivityInvalidation(event));
      if (!response.write(`data: ${data}\n\n`)) {
        await waitForDrainOrClose(response);
      }
    }
  } catch {
    // Closing the facade stream is the only safe response after SSE starts.
  } finally {
    close();
    request.off('aborted', close);
    response.off('close', close);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}

function createSdkClient(env) {
  const apiKey = env.GANTRY_CONTROL_API_KEY?.trim();
  const baseUrl = env.GANTRY_CONTROL_BASE_URL?.trim();
  const socketPath = env.GANTRY_CONTROL_SOCKET_PATH?.trim();
  if (!apiKey || (!baseUrl && !socketPath)) return null;

  return createClient({
    apiKey,
    baseUrl: baseUrl || undefined,
    socketPath: socketPath || undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

async function handleApi(method, url, request, response, env, metricsState) {
  if (method !== 'GET') {
    response.writeHead(405, { allow: 'GET' });
    response.end();
    return;
  }

  const { pathname } = url;

  const instanceMatch = pathname.match(/^\/ui\/api\/instances\/([^/]+)$/);
  const agentMatch = pathname.match(
    /^\/ui\/api\/agents\/([^/]+)(?:\/(delegation|skills|capabilities|access|activity))?$/,
  );
  const activityMatch = pathname.match(
    /^\/ui\/api\/activity\/([^/]+)(?:\/(events))?$/,
  );
  const knownPath =
    pathname === '/ui/api/connection' ||
    pathname === '/ui/api/overview' ||
    pathname === '/ui/api/metrics' ||
    pathname === '/ui/api/activity' ||
    pathname === '/ui/api/instances' ||
    pathname === '/ui/api/agents' ||
    instanceMatch ||
    agentMatch ||
    activityMatch;
  if (!knownPath) return sendNotFound(response);

  let client;
  try {
    client = createSdkClient(env);
  } catch {
    sendFailure(response, 'UI_CONFIGURATION_ERROR', false);
    return;
  }
  if (!client) {
    sendFailure(response, 'UI_NOT_CONFIGURED', false);
    return;
  }

  try {
    if (pathname === '/ui/api/connection') {
      const health = await client.health();
      sendJson(response, 200, {
        status: health.status,
        processRole: health.processRole,
        features: {
          sessions: health.features.sessions,
          jobs: health.features.jobs,
          events: health.features.events,
          webhooks: health.features.webhooks,
        },
      });
      return;
    }

    if (pathname === '/ui/api/overview') {
      const [runtimeResult, agentsResult] = await Promise.allSettled([
        client.getRuntimeSummary(),
        client.agents.list(),
      ]);
      if (
        runtimeResult.status === 'rejected' &&
        agentsResult.status === 'rejected'
      ) {
        throw new Error('Overview reads unavailable');
      }
      const projectedRuntime =
        runtimeResult.status === 'fulfilled'
          ? projectRuntime(runtimeResult.value)
          : null;
      const projectedAgents =
        agentsResult.status === 'fulfilled'
          ? agentsResult.value.agents.map(projectAgent)
          : null;
      const attention =
        projectedRuntime?.status === 'degraded' ||
        projectedRuntime?.counts.stale > 0
          ? {
              status: 'attention',
              label:
                projectedRuntime.counts.stale > 0
                  ? `${projectedRuntime.counts.stale} stale instance${projectedRuntime.counts.stale === 1 ? '' : 's'}`
                  : 'Deployment readiness is degraded',
              to: '/instances',
            }
          : projectedRuntime
            ? {
                status: 'ready',
                label: 'No instance needs attention',
                to: '/instances',
              }
            : {
                status: 'attention',
                label: 'Deployment summary is unavailable',
                to: '/instances',
              };
      sendJson(response, 200, {
        deployment: projectedRuntime,
        instanceCounts: projectedRuntime?.counts ?? null,
        agentCounts: projectedAgents
          ? {
              total: projectedAgents.length,
              active: projectedAgents.filter(
                (agent) => agent.status === 'active',
              ).length,
              disabled: projectedAgents.filter(
                (agent) => agent.status === 'disabled',
              ).length,
            }
          : null,
        unavailable: [
          ...(projectedRuntime ? [] : ['runtime']),
          ...(projectedAgents ? [] : ['agents']),
        ],
        attention,
      });
      return;
    }

    if (pathname === '/ui/api/metrics') {
      const requestedRanges = url.searchParams.getAll('range');
      const range = requestedRanges[0] ?? '24h';
      if (
        [...url.searchParams.keys()].some((key) => key !== 'range') ||
        requestedRanges.length > 1 ||
        !METRICS_RANGES.has(range)
      ) {
        sendJson(response, 400, {
          error: {
            code: 'INVALID_METRICS_RANGE',
            requestId: randomUUID(),
            retryable: false,
          },
        });
        return;
      }

      const cached = metricsState.cache.get(range);
      if (cached && cached.expiresAt > Date.now()) {
        sendJson(response, 200, cached.value);
        return;
      }
      metricsState.cache.delete(range);

      let pending = metricsState.inFlight.get(range);
      if (!pending) {
        pending = client.metrics
          .get({ range })
          .then(projectMetrics)
          .then((value) => {
            metricsState.cache.set(range, {
              value,
              expiresAt: Date.now() + METRICS_CACHE_TTL_MS,
            });
            return value;
          })
          .finally(() => metricsState.inFlight.delete(range));
        metricsState.inFlight.set(range, pending);
      }
      sendJson(response, 200, await pending);
      return;
    }

    if (pathname === '/ui/api/activity') {
      const result = await client.activity.list();
      sendJson(response, 200, { runs: result.runs.map(projectActivityRun) });
      return;
    }

    if (activityMatch) {
      const runId = decodeURIComponent(activityMatch[1]);
      if (activityMatch[2] === 'events') {
        await streamActivity(request, response, client, runId, url);
        return;
      }
      const result = await client.activity.get(runId);
      sendJson(response, 200, {
        run: projectActivityRun(result.run),
        tasks: result.tasks.map(projectActivityTask),
        taskTotal: result.taskTotal,
        truncated: result.truncated,
      });
      return;
    }

    if (pathname === '/ui/api/instances' || instanceMatch) {
      const result = await client.listRuntimeInstances();
      const instances = result.instances.map(projectInstance);
      if (instanceMatch) {
        const id = decodeURIComponent(instanceMatch[1]);
        const instance = instances.find((item) => item.id === id);
        if (!instance) return sendNotFound(response);
        sendJson(response, 200, { instance });
        return;
      }
      sendJson(response, 200, { instances });
      return;
    }

    if (pathname === '/ui/api/agents') {
      const result = await client.agents.list();
      sendJson(response, 200, {
        agents: result.agents.map(projectAgent),
      });
      return;
    }

    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const relation = agentMatch[2];
      if (!relation) {
        const result = await client.agents.getAdmin(agentId);
        sendJson(response, 200, {
          agent: projectAgent(result.agent),
          boundConversationCount: result.boundConversations.length,
        });
        return;
      }
      if (relation === 'delegation') {
        const result = await client.agents.getDelegates(agentId);
        sendJson(response, 200, {
          configured: result.delegates.map(String),
          resolved: result.resolved.map((delegate) => ({
            ref: delegate.ref,
            agentId: delegate.agentId,
            displayName: delegate.displayName,
            persona: delegate.persona,
          })),
        });
        return;
      }
      if (relation === 'skills') {
        const result = await client.agents.skills.list(agentId);
        sendJson(response, 200, {
          skills: result.bindings.map((binding) => ({
            id: String(binding.id),
            skillId: String(binding.skillId),
            status: String(binding.status),
            updatedAt: String(binding.updatedAt),
          })),
        });
        return;
      }
      if (relation === 'capabilities') {
        const result = await client.agents.getAdmin(agentId);
        sendJson(response, 200, {
          capabilities: (result.capabilities?.capabilities ?? []).map(
            (capability) => ({
              id: capability.id,
              version: capability.version,
            }),
          ),
        });
        return;
      }
      if (relation === 'access') {
        const result = await client.agents.getAccess(agentId);
        const summary = result.summary ?? {
          connected: [],
          allowed: [],
          needsAttention: [],
          suggestedCleanup: [],
        };
        sendJson(response, 200, {
          updatedAt: result.updatedAt,
          summary: {
            connected: summary.connected.map(projectAccessEntry),
            allowed: summary.allowed.map(projectAccessEntry),
            needsAttention: summary.needsAttention.map(projectAccessEntry),
            suggestedCleanup: summary.suggestedCleanup.map(projectAccessEntry),
          },
        });
        return;
      }
      const result = await client.jobs.list({ agentId, limit: 20 });
      sendJson(response, 200, {
        activity: result.jobs.map((job) => ({
          id: String(job.jobId ?? job.id),
          name: job.name,
          kind: job.kind,
          status: job.status,
          lastRun: job.lastRun ?? null,
          nextRun: job.nextRun ?? null,
        })),
      });
      return;
    }
  } catch (error) {
    if (
      activityMatch &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'RUN_NOT_FOUND'
    ) {
      sendJson(response, 404, {
        error: {
          code: 'RUN_NOT_FOUND',
          requestId: randomUUID(),
          retryable: false,
        },
      });
      return;
    }
    sendFailure(response, 'CONTROL_API_UNAVAILABLE', true);
    return;
  }
}

async function readStatic(pathname, distRoot) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice('/ui/'.length));
  } catch {
    return null;
  }

  let root;
  try {
    root = await realpath(resolve(distRoot));
  } catch {
    return null;
  }
  const requested = resolve(root, relativePath);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) return null;

  try {
    const path = await realpath(requested);
    if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
    return { path, body: await readFile(path) };
  } catch {
    if (extname(relativePath)) return null;
    try {
      const path = await realpath(resolve(root, 'index.html'));
      if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
      return { path, body: await readFile(path) };
    } catch {
      return null;
    }
  }
}

export function createUiHandler(options = {}) {
  const env = options.env ?? process.env;
  const distRoot = options.distRoot ?? DEFAULT_DIST;
  const metricsState = { cache: new Map(), inFlight: new Map() };

  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://ui.local');
    if (url.pathname === '/ui/api' || url.pathname.startsWith('/ui/api/')) {
      await handleApi(
        request.method,
        url,
        request,
        response,
        env,
        metricsState,
      );
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (url.pathname !== '/ui' && !url.pathname.startsWith('/ui/')) {
      response.writeHead(404);
      response.end();
      return;
    }

    const file = await readStatic(
      url.pathname === '/ui' || url.pathname === '/ui/'
        ? '/ui/index.html'
        : url.pathname,
      distRoot,
    );
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, {
      'content-type':
        CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream',
    });
    response.end(request.method === 'HEAD' ? undefined : file.body);
  };
}

export function createUiServer(options = {}) {
  return createServer(createUiHandler(options));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port =
    Number.parseInt(process.env.GANTRY_UI_PORT ?? '', 10) || DEFAULT_PORT;
  createUiServer().listen(port, '127.0.0.1');
}
