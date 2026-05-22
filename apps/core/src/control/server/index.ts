import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import type { RuntimeApp } from '../../app/bootstrap/runtime-app.js';
import type { JobManagementServiceDeps } from '../../application/jobs/job-management-types.js';
import {
  GANTRY_HOME,
  getControlEnvValue,
  getDefaultModelConfig,
  getRuntimeSettingsForConfig,
  getRuntimeModelDefaults,
  getPublicRuntimeSettings,
  patchRuntimeModelDefaults,
  syncRuntimeSettingsFromProjection,
} from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  getRuntimeControlRepository,
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import { preflightModelPreset } from '../../adapters/llm/model-preset-preflight.js';
import type { AppId } from '../../domain/app/app.js';
import { canAccessApp, makeAppGroup } from './app-identity.js';
import {
  isValidControlId,
  parseControlApiKeys,
  parseControlApiKeysStrict,
} from './auth.js';
import type {
  ControlRouteContext,
  ControlServerState,
} from './handler-context.js';
import { sendError } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { handleAgentRoutes } from './routes/agents.js';
import { handleCapabilityCatalogRoutes } from './routes/capability-catalog.js';
import { handleProviderConversationRoutes } from './routes/provider-conversation-routes.js';
import { handleExternalIngressRoutes } from './routes/external-ingress.js';
import { handleJobRoutes } from './routes/jobs.js';
import { handleMemoryRoutes } from './routes/memory.js';
import { handleMcpServerRoutes } from './routes/mcp-servers.js';
import { handleModelRoutes } from './routes/models.js';
import { handleOpenApiRoutes } from './routes/openapi.js';
import { handleRunRoutes } from './routes/runs.js';
import { handleSessionRoutes } from './routes/sessions.js';
import { handleSettingsRoutes } from './routes/settings.js';
import { handleSkillRoutes } from './routes/skills.js';
import { handleSystemRoutes } from './routes/system.js';
import { handleWebhookRoutes } from './routes/webhooks.js';
import {
  deliverWebhookDelivery,
  flushWebhookDeliveries,
  logWebhookFlushFailure,
} from './webhook-delivery.js';
import { isPrivateAddress } from './webhook-target.js';
import { nowIso } from '../../shared/time/datetime.js';

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

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isControlClientDisconnectError(error: unknown): boolean {
  const code = getErrorCode(error);
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}

function logControlStreamError(error: unknown, path: string): void {
  if (isControlClientDisconnectError(error)) {
    logger.debug({ err: error, path }, 'Control client disconnected');
    return;
  }
  logger.warn({ err: error, path }, 'Control request stream error');
}

function sendControlError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (res.destroyed || res.writableEnded) return;
  sendError(res, status, code, message);
}

function createControlRequestHandler(ctx: ControlRouteContext) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    req.on('error', (error) => logControlStreamError(error, pathname));
    res.on('error', (error) => logControlStreamError(error, pathname));

    try {
      if (await handleOpenApiRoutes(req, res, pathname)) return;
      if (await handleSystemRoutes(req, res, ctx, pathname)) return;
      if (await handleAgentRoutes(req, res, ctx, pathname)) return;
      if (await handleCapabilityCatalogRoutes(req, res, ctx, pathname)) return;
      if (await handleSessionRoutes(req, res, ctx, url, pathname)) return;
      if (await handleProviderConversationRoutes(req, res, ctx, url, pathname))
        return;
      if (await handleMemoryRoutes(req, res, ctx, url, pathname)) return;
      if (await handleModelRoutes(req, res, ctx, pathname)) return;
      if (await handleJobRoutes(req, res, ctx, url, pathname)) return;
      if (await handleExternalIngressRoutes(req, res, ctx, pathname)) return;
      if (await handleRunRoutes(req, res, ctx, url, pathname)) return;
      if (await handleSettingsRoutes(req, res, ctx, pathname)) return;
      if (await handleSkillRoutes(req, res, ctx, url, pathname)) return;
      if (await handleMcpServerRoutes(req, res, ctx, url, pathname)) return;
      if (await handleWebhookRoutes(req, res, ctx, pathname)) return;

      sendControlError(res, 404, 'NOT_FOUND', 'Route not found');
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
        sendControlError(
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
      sendControlError(
        res,
        500,
        'INTERNAL_ERROR',
        'Control server request failed',
      );
    }
  };
}

export function startControlServer(input: {
  app: RuntimeApp;
  getBrowserStatus?: JobManagementServiceDeps['getBrowserStatus'];
}): ControlServerHandle {
  const keys = parseControlApiKeysStrict({
    rawJson: getControlEnvValue('GANTRY_CONTROL_API_KEYS_JSON'),
  });
  const socketPath =
    getControlEnvValue('GANTRY_CONTROL_SOCKET_PATH') ||
    path.join(GANTRY_HOME, 'run', 'control.sock');
  const port = Number(getControlEnvValue('GANTRY_CONTROL_PORT') || 0);
  const host = resolveControlHost();
  const state: ControlServerState = {
    activeStreams: 0,
    activeWaits: 0,
    activeTriggerWaits: 0,
  };
  let webhookFlushInFlight = false;
  const ctx: ControlRouteContext = {
    app: input.app,
    runtimeHome: GANTRY_HOME,
    keys,
    socketPath,
    port,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state,
    triggerRateLimiter: createRateLimiter(),
    getRuntimeSettings: () => getPublicRuntimeSettings(),
    getDefaultModelConfig,
    getModelDefaults: getRuntimeModelDefaults,
    patchModelDefaults: patchRuntimeModelDefaults,
    preflightModelPreset: (preset) =>
      preflightModelPreset({
        runtimeHome: GANTRY_HOME,
        preset,
        settings: getRuntimeSettingsForConfig(),
      }),
    getBrowserStatus: input.getBrowserStatus,
    syncSettingsFromProjection: (appId: AppId) =>
      syncRuntimeSettingsFromProjection({
        runtimeHome: GANTRY_HOME,
        ops: getRuntimeRepositories(),
        repositories: getRuntimeStorage().repositories,
        appId,
        reloadRuntimeState: () => input.app.loadState(),
      }),
  };

  const server = http.createServer(createControlRequestHandler(ctx));
  server.on('clientError', (error, socket) => {
    if (isControlClientDisconnectError(error)) {
      logger.debug({ err: error }, 'Control client socket disconnected');
    } else {
      logger.warn({ err: error }, 'Control client socket error');
    }
    socket.destroy();
  });

  if (port > 0) {
    server.listen(port, host);
    logger.info({ host, port }, 'Control server listening on TCP');
  } else {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch (error) {
        logger.warn(
          { err: error, socketPath },
          'Failed to remove stale control socket before listen',
        );
      }
    }
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
  let ingressMaintenanceInFlight = false;
  const ingressMaintenanceInterval = setInterval(() => {
    if (ingressMaintenanceInFlight) return;
    ingressMaintenanceInFlight = true;
    void getRuntimeControlRepository()
      .sweepExpiredExternalIngressState({
        now: nowIso(),
      })
      .catch((error) => {
        logger.warn(
          { err: error },
          'Failed sweeping expired external ingress state',
        );
      })
      .finally(() => {
        ingressMaintenanceInFlight = false;
      });
  }, 60_000);

  return {
    async close() {
      clearInterval(deliveryInterval);
      clearInterval(ingressMaintenanceInterval);
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
        if (fs.existsSync(socketPath)) {
          try {
            fs.unlinkSync(socketPath);
          } catch (error) {
            logger.warn(
              { err: error, socketPath },
              'Failed to remove control socket during close',
            );
          }
        }
      }
    },
  };
}

function resolveControlHost(): string {
  return getControlEnvValue('GANTRY_CONTROL_HOST') || '127.0.0.1';
}

export const _testControlServer = {
  parseControlApiKeys,
  parseControlApiKeysStrict,
  canAccessApp,
  applyControlSocketMode,
  isControlClientDisconnectError,
  isValidControlId,
  isPrivateAddress,
  makeAppGroup,
  resolveControlHost,
  deliverWebhookDelivery,
  flushWebhookDeliveries,
};
