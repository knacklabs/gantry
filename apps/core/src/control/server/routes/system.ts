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
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { postgresMigrationsFolder } from '../../../adapters/storage/postgres/storage-service.js';
import { getRuntimeSettingsForConfig } from '../../../config/index.js';
import { areSettingsLoaded } from '../../../runtime/settings-load-state.js';
import type { AppId } from '../../../domain/app/app.js';

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
    const deps: ReadinessDeps = {
      role: ctx.processRole,
      requirements: ctx.roleReadinessRequirements,
      query: runtimeQuery,
      shippedMigrationCount,
      settingsLoaded,
      isDraining,
      apiKeyCount: () => ctx.keys.length,
      workerRegistered: () =>
        (ctx.currentWorkerInstanceId?.() ?? null) !== null,
      schedulerReady: () => ctx.isSchedulerReady?.() ?? false,
      liveCapacityLimit: () => ctx.liveCapacityLimit?.() ?? 0,
      currentWorkerInstanceId: () => ctx.currentWorkerInstanceId?.() ?? null,
    };
    const result = await evaluateReadiness(deps);
    sendJson(res, result.ready ? 200 : 503, {
      status: result.ready ? 'ready' : 'not_ready',
      role: result.role,
      checks: result.checks,
      ...(result.ready ? {} : { failing: result.failing }),
    });
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
