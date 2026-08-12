import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from '../http.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { buildControlPlaneReadModelForRequest } from '../control-plane-request-model.js';
import {
  evaluateReadiness,
  renderMetrics,
  type ReadinessDeps,
  type MetricsDeps,
} from '../system-health.js';
import { isDraining } from '../../../app/bootstrap/draining-state.js';
import {
  getRuntimeStorage,
  getWorkerCoordinationRepository,
} from '../../../adapters/storage/postgres/runtime-store.js';
import { postgresMigrationsFolder } from '../../../adapters/storage/postgres/storage-service.js';
import { getRuntimeSettingsForConfig } from '../../../config/index.js';
import { areSettingsLoaded } from '../../../runtime/settings-load-state.js';
import type { AppId } from '../../../domain/app/app.js';
import type {
  RuntimeCapacity,
  RuntimeInstance,
  RuntimeProcessRole,
  RuntimeReadiness,
} from '@gantry/contracts';
import { WORKER_STALE_AFTER_MS } from '../../../shared/worker-heartbeat.js';

let shippedMigrationCountCache: number | undefined;

/** Count of migrations shipped in this build, from the drizzle journal. */
function shippedMigrationCount(): number {
  if (shippedMigrationCountCache !== undefined) {
    return shippedMigrationCountCache;
  }
  try {
    const journalPath = path.join(
      postgresMigrationsFolder,
      'meta',
      '_journal.json',
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries?: unknown[];
    };
    shippedMigrationCountCache = Array.isArray(journal.entries)
      ? journal.entries.length
      : 0;
  } catch {
    shippedMigrationCountCache = 0;
  }
  return shippedMigrationCountCache;
}

/** Runs a parameterless query against the runtime pool; throws when down. */
async function runtimeQuery<T>(sql: string): Promise<T[]> {
  const result = await getRuntimeStorage().service.pool.query(sql);
  return result.rows as T[];
}

function settingsLoaded(): boolean {
  // The process-level gate is the fleet first-boot signal: a fleet worker with
  // no applied settings revision reports not-loaded even though a bootstrap
  // settings.yaml exists on disk.
  if (!areSettingsLoaded()) return false;
  try {
    return Boolean(getRuntimeSettingsForConfig());
  } catch {
    return false;
  }
}

function readinessDeps(ctx: ControlRouteContext): ReadinessDeps {
  return {
    role: ctx.processRole,
    requirements: ctx.roleReadinessRequirements,
    query: runtimeQuery,
    shippedMigrationCount,
    settingsLoaded,
    isDraining,
    apiKeyCount: () => ctx.keys.length,
    workerRegistered: () => (ctx.currentWorkerInstanceId?.() ?? null) !== null,
    schedulerReady: () => ctx.isSchedulerReady?.() ?? false,
    liveCapacityLimit: () => ctx.liveCapacityLimit?.() ?? 0,
    currentWorkerInstanceId: () => ctx.currentWorkerInstanceId?.() ?? null,
  };
}

function safeReadiness(
  result: Awaited<ReturnType<typeof evaluateReadiness>>,
): RuntimeReadiness {
  return {
    status: result.ready ? 'ready' : 'degraded',
    checks: {
      database: result.checks.database,
      migrations: result.checks.migrations,
      settings: result.checks.settings,
      draining: result.checks.draining,
      ...(result.checks.api_auth ? { apiAuth: result.checks.api_auth } : {}),
      ...(result.checks.worker_registered
        ? { workerRegistered: result.checks.worker_registered }
        : {}),
      ...(result.checks.scheduler
        ? { scheduler: result.checks.scheduler }
        : {}),
      ...(result.checks.live_capacity
        ? { liveCapacity: result.checks.live_capacity }
        : {}),
    },
    failing: result.failing as RuntimeReadiness['failing'],
  };
}

function currentCapacity(ctx: ControlRouteContext): RuntimeCapacity {
  const liveLimit =
    ctx.processRole === 'all' || ctx.processRole === 'live-worker'
      ? (ctx.liveCapacityLimit?.() ?? 0)
      : 0;
  let jobLimit: number | null = 0;
  if (ctx.processRole === 'all' || ctx.processRole === 'job-worker') {
    try {
      jobLimit = getRuntimeSettingsForConfig().runtime.queue.maxJobRuns;
    } catch {
      jobLimit = null;
    }
  }
  return { liveLimit, jobLimit };
}

async function runtimeInventory(ctx: ControlRouteContext) {
  const nowMs = Date.now();
  const readiness = safeReadiness(await evaluateReadiness(readinessDeps(ctx)));
  const capacity = currentCapacity(ctx);
  const currentId = ctx.currentWorkerInstanceId?.() ?? null;
  const workers = (
    await getWorkerCoordinationRepository().listWorkers()
  ).filter(
    (worker) =>
      worker.id === currentId ||
      worker.processRole === 'all' ||
      worker.processRole === 'live-worker' ||
      worker.processRole === 'job-worker',
  );
  const instances: RuntimeInstance[] = workers.map((worker) => ({
    id: worker.id,
    role: worker.processRole as RuntimeProcessRole,
    status: worker.status,
    heartbeat: {
      status:
        nowMs - Date.parse(worker.heartbeatAt) >= WORKER_STALE_AFTER_MS
          ? 'stale'
          : 'fresh',
      at: worker.heartbeatAt,
    },
    readiness: worker.id === currentId ? readiness : null,
    capacity: worker.id === currentId ? capacity : null,
    capabilities: worker.capabilities,
    startedAt: worker.createdAt,
    lastSeenAt: worker.lastSeenAt,
  }));

  if (!currentId || !instances.some((instance) => instance.id === currentId)) {
    const startedAt = new Date(nowMs - process.uptime() * 1000).toISOString();
    instances.unshift({
      id: currentId ?? `${ctx.processRole}:self`,
      role: ctx.processRole,
      status: 'running',
      heartbeat: { status: 'not-applicable', at: null },
      readiness,
      capacity,
      capabilities: [],
      startedAt,
      lastSeenAt: new Date(nowMs).toISOString(),
    });
  }

  return { readiness, capacity, instances };
}

export async function handleSystemRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  // Unversioned operational endpoints, deliberately distinct from /v1/* and
  // unauthenticated by design — internal-only; ALB rules own their exposure.
  if (pathname === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { status: 'ok' });
    return true;
  }

  if (pathname === '/readyz' && req.method === 'GET') {
    const result = await evaluateReadiness(readinessDeps(ctx));
    sendJson(res, result.ready ? 200 : 503, {
      status: result.ready ? 'ready' : 'not_ready',
      role: result.role,
      checks: result.checks,
      ...(result.ready ? {} : { failing: result.failing }),
    });
    return true;
  }

  if (pathname === '/v1/runtime' && req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    const inventory = await runtimeInventory(ctx);
    const roles = inventory.instances.map((instance) => instance.role);
    sendJson(res, 200, {
      role: ctx.processRole,
      status: inventory.readiness.status,
      uptimeSeconds: process.uptime(),
      capacity: inventory.capacity,
      counts: {
        instances: inventory.instances.length,
        liveWorkers: roles.filter(
          (role) => role === 'all' || role === 'live-worker',
        ).length,
        jobWorkers: roles.filter(
          (role) => role === 'all' || role === 'job-worker',
        ).length,
        stale: inventory.instances.filter(
          (instance) => instance.heartbeat.status === 'stale',
        ).length,
      },
      readiness: inventory.readiness,
    });
    return true;
  }

  if (pathname === '/v1/runtime/instances' && req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    const { instances } = await runtimeInventory(ctx);
    sendJson(res, 200, { instances });
    return true;
  }

  if (pathname === '/metrics' && req.method === 'GET') {
    const deps: MetricsDeps = {
      query: runtimeQuery,
      isDraining,
      uptimeSeconds: () => process.uptime(),
      role: ctx.processRole,
      liveExecutionEnabled: ctx.liveExecution,
      currentWorkerInstanceId: () => ctx.currentWorkerInstanceId?.() ?? null,
      liveCapacityLimit: () => ctx.liveCapacityLimit?.() ?? 0,
      jobCapacityLimit: () =>
        getRuntimeSettingsForConfig().runtime.queue.maxJobRuns,
      oldestWaitingLiveAdmissionSeconds: () =>
        ctx.oldestWaitingLiveAdmissionSeconds?.() ?? 0,
    };
    const body = await renderMetrics(deps);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(body);
    return true;
  }

  if (pathname === '/v1/status' && req.method === 'GET') {
    const key = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!key) return true;
    const model = await buildControlPlaneReadModelForRequest(
      ctx,
      key.appId as AppId,
    );
    sendJson(res, 200, model);
    return true;
  }

  if (pathname === '/v1/health' && req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    sendJson(res, 200, {
      status: 'ok',
      processRole: ctx.processRole,
      transport:
        ctx.port > 0
          ? { kind: 'tcp', port: ctx.port }
          : { kind: 'unix', socketPath: ctx.socketPath },
      features: {
        sessions: true,
        jobs: true,
        events: true,
        webhooks: true,
      },
    });
    return true;
  }

  if (pathname === '/v1/doctor' && req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    sendJson(res, 200, {
      status: 'ok',
      checks: [
        {
          id: 'storage',
          status: 'ok',
          message: 'Postgres control store available',
        },
        {
          id: 'auth',
          status: ctx.keys.length > 0 ? 'ok' : 'warn',
          message:
            ctx.keys.length > 0
              ? 'API keys configured'
              : 'No control API keys configured',
        },
      ],
    });
    return true;
  }

  return false;
}
