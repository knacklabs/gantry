import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ControlRouteContext } from '../handler-context.js';
import { sendError, sendJson } from '../http.js';
import { activeSession } from './browser-auth.js';

type BrowserRuntimeStatusSettings = {
  authentication: { mode: 'local' | 'hosted' };
};

const RUNTIME_STATUS_PATH = '/ui/api/runtime-status';

export function isBrowserRuntimeStatusPath(pathname: string): boolean {
  return pathname === RUNTIME_STATUS_PATH;
}

export async function handleBrowserRuntimeStatus(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserRuntimeStatusSettings,
): Promise<boolean> {
  if (!isBrowserRuntimeStatusPath(pathname)) return false;
  if (req.method !== 'GET') return false;

  if (!(await activeSession(req, settings.authentication.mode))) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }

  sendJson(res, 200, {
    status: 'connected',
    processRole: ctx.processRole,
  });
  return true;
}
