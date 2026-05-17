import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/v1/settings') return false;

  if (req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['agents:admin'])) {
      return true;
    }
    sendJson(res, 200, { settings: ctx.getRuntimeSettings() });
    return true;
  }

  if (req.method === 'PATCH') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['agents:admin'])) {
      return true;
    }
    sendJson(res, 200, ctx.updateRuntimeSettings(await readJson(req)));
    return true;
  }

  res.setHeader('Allow', 'GET, PATCH');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}
