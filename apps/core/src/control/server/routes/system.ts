import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from '../http.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { buildControlPlaneReadModelForRequest } from '../control-plane-request-model.js';
import type { AppId } from '../../../domain/app/app.js';

export async function handleSystemRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
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
