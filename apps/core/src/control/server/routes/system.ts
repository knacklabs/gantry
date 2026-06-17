import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from '../http.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import type { AppId } from '../../../domain/app/app.js';
import { summarizeWorkerInventorySnapshots } from '../../../runtime/worker-inventory-snapshot.js';

const WORKER_INVENTORY_STALE_AFTER_MS = 60_000;

export async function handleSystemRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/health' && req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    sendJson(res, 200, {
      status: 'ok',
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

  if (pathname === '/v1/runtime/workers' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) {
      return true;
    }
    const now = new Date();
    const snapshots = ctx.listWorkerInventorySnapshots
      ? await ctx.listWorkerInventorySnapshots({ appId: auth.appId as AppId })
      : [ctx.app.getWorkerInventorySnapshot(now)];
    sendJson(
      res,
      200,
      summarizeWorkerInventorySnapshots({
        snapshots,
        now,
        staleAfterMs: WORKER_INVENTORY_STALE_AFTER_MS,
      }),
    );
    return true;
  }

  return false;
}
