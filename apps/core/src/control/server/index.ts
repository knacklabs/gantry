import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import type { RuntimeApp } from '../../app/bootstrap/runtime-app.js';
import type {
  ProcessRole,
  ReadinessRoleRequirements,
} from './system-health.js';
import type { JobManagementServiceDeps } from '../../application/jobs/job-management-types.js';
import {
  DEFAULT_JOB_RUNTIME_APP_ID,
  filterJobsByCanonicalAppSession,
} from '../../application/jobs/job-access.js';
import {
  GANTRY_HOME,
  configureDesiredSettingsStorageProvider,
  getControlEnvValue,
  getDefaultModelConfig,
  getSelectedAgentHarness,
  getRuntimeSettingsForConfig,
  getRuntimeModelDefaults,
  getPublicRuntimeSettings,
  patchRuntimeModelDefaults,
  syncRuntimeSettingsFromProjection,
} from '../../config/index.js';
import {
  resolveRuntimeSecurityPosture,
  validateProductionSecurityGate,
} from '../../shared/security-posture.js';
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
import { handleCredentialRoutes } from './routes/credentials.js';
import { handleProviderConversationRoutes } from './routes/provider-conversation-routes.js';
import { handleExternalIngressRoutes } from './routes/external-ingress.js';
import { handleGuidedActionRoutes } from './routes/guided-actions.js';
import { handleJobRoutes } from './routes/jobs.js';
import { handleMemoryRoutes } from './routes/memory.js';
import { handleMcpServerRoutes } from './routes/mcp-servers.js';
import {
  flushExternalPlatformEventDeliveries,
  handleExternalPlatformEventRoutes,
} from './routes/external-platform-events.js';
import { handleModelRoutes } from './routes/models.js';
import { handleOpenApiRoutes } from './routes/openapi.js';
import { handleRunRoutes } from './routes/runs.js';
import { handleSessionRoutes } from './routes/sessions.js';
import { handleSettingsRoutes } from './routes/settings.js';
import { handleSkillRoutes } from './routes/skills.js';
import { handleSystemRoutes } from './routes/system.js';
import { handleTeamsActivityRoutes } from './routes/teams-activities.js';
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

function createControlRequestHandler(
  ctx: ControlRouteContext,
  routeProfile: 'full' | 'ops',
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    req.on('error', (error) => logControlStreamError(error, pathname));
    res.on('error', (error) => logControlStreamError(error, pathname));

    try {
      // Ops profile (live-worker, job-worker) serves only operational and
      // read-only diagnostic routes; every admin/mutation route is unmounted and
      // falls through to the 404 fallback below.
      if (routeProfile === 'ops') {
        if (await handleSystemRoutes(req, res, ctx, pathname)) return;
        if (isLiveIngressRoute(pathname)) {
          if (await handleExternalIngressRoutes(req, res, ctx, pathname))
            return;
        }
        sendControlError(res, 404, 'NOT_FOUND', 'Route not found');
        return;
      }
      if (await handleTeamsActivityRoutes(req, res, pathname)) return;
      if (await handleExternalPlatformEventRoutes(req, res, ctx, pathname))
        return;
      if (await handleOpenApiRoutes(req, res, pathname)) return;
      if (await handleSystemRoutes(req, res, ctx, pathname)) return;
      if (await handleGuidedActionRoutes(req, res, ctx, pathname)) return;
      if (await handleAgentRoutes(req, res, ctx, pathname)) return;
      if (await handleCapabilityCatalogRoutes(req, res, ctx, pathname)) return;
      if (await handleSessionRoutes(req, res, ctx, url, pathname)) return;
      if (await handleProviderConversationRoutes(req, res, ctx, url, pathname))
        return;
      if (await handleMemoryRoutes(req, res, ctx, url, pathname)) return;
      if (await handleCredentialRoutes(req, res, ctx, pathname)) return;
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

function isLiveIngressRoute(pathname: string): boolean {
  return /^\/webhooks\/[^/]+(?:\/wait)?$/.test(pathname);
}

export function startControlServer(input: {
  app: RuntimeApp;
  getBrowserStatus?: JobManagementServiceDeps['getBrowserStatus'];
  sendConversationIngressProjection?: ControlRouteContext['sendConversationIngressProjection'];
  /**
   * Which control routes to mount. `'full'` (default) mounts every route, the
   * historical behaviour. `'ops'` mounts only operational + read-only diagnostic
   * routes for worker roles, 404ing all admin/mutation routes.
   */
  routeProfile?: 'full' | 'ops';
  /** Process role this server runs as; surfaced on /readyz, /metrics, /v1/health. */
  processRole?: ProcessRole;
  /** Whether this role runs live execution (live readiness + live gauges). */
  liveExecution?: boolean;
  /** Role-specific readiness checks that apply (derived by the runtime caller). */
  roleReadinessRequirements?: ReadinessRoleRequirements;
  /** Runtime accessors injected from the runtime layer (DI; no cross-layer import here). */
  currentWorkerInstanceId?: () => string | null;
  isSchedulerReady?: () => boolean;
  oldestWaitingLiveAdmissionSeconds?: () => number;
  liveCapacityLimit?: () => number;
}): ControlServerHandle {
  configureDesiredSettingsStorageProvider(async () => {
    const storage = getRuntimeStorage();
    return {
      ops: getRuntimeRepositories(),
      repositories: storage.repositories,
    };
  });
  const socketPath =
    getControlEnvValue('GANTRY_CONTROL_SOCKET_PATH') ||
    path.join(GANTRY_HOME, 'run', 'control.sock');
  const port = Number(getControlEnvValue('GANTRY_CONTROL_PORT') || 0);
  const host = resolveControlHost();
  const nodeEnv = getControlEnvValue('NODE_ENV');
  const securityPosture = getControlEnvValue('GANTRY_SECURITY_POSTURE');
  const runtimeEnv = getControlEnvValue('GANTRY_RUNTIME_ENV');
  const posture = resolveRuntimeSecurityPosture({
    NODE_ENV: nodeEnv,
    GANTRY_SECURITY_POSTURE: securityPosture,
    GANTRY_RUNTIME_ENV: runtimeEnv,
    GANTRY_CONTROL_HOST: host,
    GANTRY_CONTROL_PORT: String(port),
  });
  const rawControlKeys = getControlEnvValue('GANTRY_CONTROL_API_KEYS_JSON');
  const keys = parseControlApiKeysStrict({
    rawJson: rawControlKeys,
    requireStrongTokens: posture.requiresProductionSecrets,
    requireNonEmptyScopes: posture.requiresProductionSecrets,
  });
  const sandboxProvider = posture.requiresEnforcingSandbox
    ? getRuntimeSettingsForConfig().runtime.sandbox.provider
    : undefined;
  const productionFailures = validateProductionSecurityGate({
    env: {
      NODE_ENV: nodeEnv,
      GANTRY_SECURITY_POSTURE: securityPosture,
      GANTRY_RUNTIME_ENV: runtimeEnv,
      GANTRY_CONTROL_HOST: host,
      GANTRY_CONTROL_PORT: String(port),
      GANTRY_CONTROL_API_KEYS_JSON: rawControlKeys,
      GANTRY_IPC_AUTH_SECRET: getControlEnvValue('GANTRY_IPC_AUTH_SECRET'),
      REMOTE_CONTROL_AUTO_ACCEPT: getControlEnvValue(
        'REMOTE_CONTROL_AUTO_ACCEPT',
      ),
      SECRET_ENCRYPTION_KEY: getControlEnvValue('SECRET_ENCRYPTION_KEY'),
      SECRET_ENCRYPTION_KEYRING_JSON: getControlEnvValue(
        'SECRET_ENCRYPTION_KEYRING_JSON',
      ),
    },
    sandboxProvider,
  });
  if (productionFailures.length > 0) {
    throw new Error(
      ['Production security preflight failed.', ...productionFailures].join(
        '\n- ',
      ),
    );
  }
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
    processRole: input.processRole ?? 'all',
    liveExecution: input.liveExecution ?? true,
    roleReadinessRequirements: input.roleReadinessRequirements ?? {
      // Default (workstation `all`): the historical check set, no role checks.
      requiresApiAuthConfigured: false,
      requiresWorkerRegistration: false,
      requiresSchedulerClaiming: false,
      requiresLiveCapacitySignal: false,
    },
    currentWorkerInstanceId: input.currentWorkerInstanceId,
    isSchedulerReady: input.isSchedulerReady,
    oldestWaitingLiveAdmissionSeconds: input.oldestWaitingLiveAdmissionSeconds,
    liveCapacityLimit: input.liveCapacityLimit,
    socketPath,
    port,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state,
    triggerRateLimiter: createRateLimiter(),
    getRuntimeSettings: () => getPublicRuntimeSettings(),
    getInternalRuntimeSettings: () => getRuntimeSettingsForConfig(),
    getDefaultModelConfig,
    getModelDefaults: getRuntimeModelDefaults,
    patchModelDefaults: patchRuntimeModelDefaults,
    preflightModelPreset: (preset, appId) =>
      preflightModelPreset({
        runtimeHome: GANTRY_HOME,
        preset,
        settings: getRuntimeSettingsForConfig(),
        appId,
      }),
    getActiveModelCredentialProviderIds: async (appId: AppId) => {
      try {
        const credentials =
          await getRuntimeStorage().repositories.modelCredentials.listModelCredentials(
            { appId },
          );
        return credentials
          .filter((credential) => credential.status === 'active')
          .map((credential) => credential.providerId);
      } catch {
        // Best-effort: availability reads (model catalog `available`, why/preview
        // badges) must never fail the response on a credential-store error;
        // degrade to "none configured".
        return [];
      }
    },
    countPendingAccessRequests: async (appId: AppId) =>
      getRuntimeStorage().repositories.pendingAccessRequests.countPendingAccessRequests(
        { appId },
      ),
    listControlPlaneJobs: async (appId: AppId) => {
      const jobs = await getRuntimeRepositories().listJobs({
        ...(appId === DEFAULT_JOB_RUNTIME_APP_ID ? {} : { appId }),
      });
      return filterJobsByCanonicalAppSession({
        control: getRuntimeStorage().control,
        jobs,
        appId,
      });
    },
    sendConversationIngressProjection: input.sendConversationIngressProjection,
    getBrowserStatus: input.getBrowserStatus,
    syncSettingsFromProjection: (appId: AppId) =>
      syncRuntimeSettingsFromProjection({
        runtimeHome: GANTRY_HOME,
        ops: getRuntimeRepositories(),
        repositories: getRuntimeStorage().repositories,
        appId,
        reloadRuntimeState: () => input.app.loadState(),
      }),
    getSelectedAgentHarness: (agentFolder?: string) =>
      getSelectedAgentHarness(agentFolder),
  };

  const server = http.createServer(
    createControlRequestHandler(ctx, input.routeProfile ?? 'full'),
  );
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
  let externalDeliveryFlushInFlight = false;
  const externalDeliveryInterval = setInterval(() => {
    if (externalDeliveryFlushInFlight) return;
    externalDeliveryFlushInFlight = true;
    void flushExternalPlatformEventDeliveries(ctx)
      .catch((error) => {
        logger.warn({ err: error }, 'Failed flushing External platform events');
      })
      .finally(() => {
        externalDeliveryFlushInFlight = false;
      });
  }, 5000);
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
      clearInterval(externalDeliveryInterval);
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
