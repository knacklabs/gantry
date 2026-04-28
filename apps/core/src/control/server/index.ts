import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import type { RuntimeApp } from '../../app/bootstrap/runtime-app.js';
import { MYCLAW_HOME } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { canAccessApp, jobBelongsToApp, makeAppGroup } from './app-identity.js';
import { isValidControlId, parseControlApiKeys } from './auth.js';
import type {
  ControlRouteContext,
  ControlServerState,
} from './handler-context.js';
import { sendError } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { handleChannelControlRoutes } from './routes/channels.js';
import { handleJobRoutes } from './routes/jobs.js';
import { handleMemoryRoutes } from './routes/memory.js';
import { handleRunRoutes } from './routes/runs.js';
import { handleSessionRoutes } from './routes/sessions.js';
import { handleSkillRoutes } from './routes/skills.js';
import { handleSystemRoutes } from './routes/system.js';
import { handleWebhookRoutes } from './routes/webhooks.js';
import {
  deliverWebhookDelivery,
  flushWebhookDeliveries,
  logWebhookFlushFailure,
} from './webhook-delivery.js';
import { isPrivateAddress } from './webhook-target.js';

export interface ControlServerHandle {
  close: () => Promise<void>;
}

function applyControlSocketMode(
  socketPath: string,
  server: Pick<http.Server, 'close'>,
): boolean {
  try {
    fs.chmodSync(socketPath, 0o600);
    return true;
  } catch (error) {
    logger.error(
      { err: error, socketPath },
      'Failed to set control socket mode to 0600; closing control server',
    );
    server.close();
    return false;
  }
}

function createControlRequestHandler(ctx: ControlRouteContext) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      if (await handleSystemRoutes(req, res, ctx, pathname)) return;
      if (await handleSessionRoutes(req, res, ctx, url, pathname)) return;
      if (await handleChannelControlRoutes(req, res, ctx, url, pathname))
        return;
      if (await handleMemoryRoutes(req, res, ctx, url, pathname)) return;
      if (await handleJobRoutes(req, res, ctx, url, pathname)) return;
      if (await handleRunRoutes(req, res, ctx, url, pathname)) return;
      if (await handleSkillRoutes(req, res, ctx, url, pathname)) return;
      if (await handleWebhookRoutes(req, res, ctx, pathname)) return;

      sendError(res, 404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
      ) {
        const errorCode =
          'code' in error && typeof error.code === 'string'
            ? error.code
            : 'INVALID_REQUEST';
        sendError(
          res,
          error.statusCode,
          errorCode,
          error instanceof Error ? error.message : 'Request failed',
        );
        return;
      }
      logger.error(
        { err: error, path: pathname },
        'Control server request failed',
      );
      sendError(res, 500, 'INTERNAL_ERROR', 'Control server request failed');
    }
  };
}

export function startControlServer(input: {
  app: RuntimeApp;
}): ControlServerHandle {
  const keys = parseControlApiKeys();
  const socketPath =
    process.env.MYCLAW_CONTROL_SOCKET_PATH?.trim() ||
    path.join(MYCLAW_HOME, 'run', 'control.sock');
  const port = Number(process.env.MYCLAW_CONTROL_PORT || 0);
  const state: ControlServerState = {
    activeStreams: 0,
    activeWaits: 0,
    activeTriggerWaits: 0,
  };
  let webhookFlushInFlight = false;
  const ctx: ControlRouteContext = {
    app: input.app,
    keys,
    socketPath,
    port,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state,
    triggerRateLimiter: createRateLimiter(),
  };

  const server = http.createServer(createControlRequestHandler(ctx));

  if (port > 0) {
    server.listen(port, '127.0.0.1');
    logger.info({ port }, 'Control server listening on TCP');
  } else {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    server.listen(socketPath, () => applyControlSocketMode(socketPath, server));
    logger.info({ socketPath }, 'Control server listening on unix socket');
  }

  const deliveryInterval = setInterval(() => {
    if (webhookFlushInFlight) return;
    webhookFlushInFlight = true;
    void flushWebhookDeliveries()
      .catch(logWebhookFlushFailure)
      .finally(() => {
        webhookFlushInFlight = false;
      });
  }, 1000);

  return {
    async close() {
      clearInterval(deliveryInterval);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (port === 0) {
        try {
          fs.unlinkSync(socketPath);
        } catch {}
      }
    },
  };
}

export const _testControlServer = {
  parseControlApiKeys,
  canAccessApp,
  applyControlSocketMode,
  isValidControlId,
  isPrivateAddress,
  jobBelongsToApp,
  makeAppGroup,
  deliverWebhookDelivery,
  flushWebhookDeliveries,
};
