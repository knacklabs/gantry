import type { IncomingMessage, ServerResponse } from 'node:http';

import { UpdateRuntimeSettingsRequestSchema } from '@myclaw/contracts';

import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

function parseUpdate(patch: unknown) {
  const parsed = UpdateRuntimeSettingsRequestSchema.safeParse(patch);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw Object.assign(new Error(message || 'Invalid settings update'), {
      statusCode: 400,
      code: 'INVALID_REQUEST',
    });
  }
  return parsed.data;
}

export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/v1/settings') return false;

  if (req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    sendJson(res, 200, { settings: ctx.getRuntimeSettings() });
    return true;
  }

  if (req.method === 'PATCH') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['agents:admin'])) {
      return true;
    }
    try {
      sendJson(
        res,
        200,
        ctx.updateRuntimeSettings(parseUpdate(await readJson(req))),
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
      ) {
        sendError(
          res,
          error.statusCode,
          'code' in error && typeof error.code === 'string'
            ? error.code
            : 'INVALID_REQUEST',
          error instanceof Error ? error.message : 'Invalid settings update',
        );
        return true;
      }
      throw error;
    }
    return true;
  }

  res.setHeader('Allow', 'GET, PATCH');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}
