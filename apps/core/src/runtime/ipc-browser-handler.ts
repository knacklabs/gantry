import fs from 'fs';
import path from 'path';

import { BROWSER_IPC_ACTIONS, type BrowserIpcAction } from '@myclaw/contracts';

import { DATA_DIR } from '../config/index.js';
import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import { nowMs } from '../shared/time/datetime.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  closeBrowser,
  ensureBrowserReady,
  getBrowserStatus,
} from './browser-capability.js';
import {
  type BrowserCdpTargetOptions,
  ensureBrowserTarget,
  foregroundBrowserTarget,
  resizeHeadedBrowserWindow,
} from './browser-cdp-targets.js';
import { type IpcDomainContext } from './ipc-domain-types.js';
import type { CredentialBrokerHealth } from '../domain/models/credentials.js';
import { memoryAgentIdForGroupFolder } from '../memory/app-memory-boundaries.js';

interface BrowserRequest {
  requestId: string;
  action: BrowserIpcAction;
  payload: Record<string, unknown>;
}

interface BrowserResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type BrowserContext = Pick<
  IpcDomainContext,
  'sourceAgentFolder' | 'browserProfileName'
> & {
  browserIpcAuthorized?: boolean;
  getCredentialBroker?: IpcDomainContext['deps']['getCredentialBroker'];
  getCredentialBrokerProfile?: IpcDomainContext['deps']['getCredentialBrokerProfile'];
  callBrowserTool?: IpcDomainContext['deps']['callBrowserTool'];
  closeBrowserToolBackends?: IpcDomainContext['deps']['closeBrowserToolBackends'];
  timeoutMs?: number;
  deadlineAtMs?: number;
};
type BrowserStatusPayload = Record<string, unknown> & {
  brokerHealthy?: boolean;
  brokerHealth?: CredentialBrokerHealth;
  warning?: string;
};
const BROKER_HEALTH_CACHE_MS = 5_000;
const MIN_BROWSER_BACKEND_TIMEOUT_MS = 1_000;
const MAX_HEADED_BROWSER_RESIZE_DIMENSION = 8_192;
const brokerHealthCache = new Map<
  string,
  { expiresAt: number; value: CredentialBrokerHealth | undefined }
>();
const POINTER_ACTIONS = new Set<BrowserIpcAction>([
  'browser_click',
  'browser_hover',
  'browser_drag',
  'browser_drop',
  'browser_select_option',
  'browser_fill_form',
]);
const FOREGROUND_BEFORE_DISPATCH_ACTIONS = new Set<BrowserIpcAction>([
  ...POINTER_ACTIONS,
  'browser_take_screenshot',
]);

interface BrowserIpcDeadline {
  deadlineAtMs?: number;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toOptionalNumber(
  value: unknown,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (opts.min !== undefined && value < opts.min) return undefined;
  if (opts.max !== undefined && value > opts.max) return undefined;
  return value;
}

function getProfileNameFromPayload(
  payload: Record<string, unknown>,
  context: BrowserContext,
): string {
  void payload;
  return context.browserProfileName || DEFAULT_BROWSER_PROFILE_NAME;
}

function sanitizeBrowserStatus(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  return {
    profile: row.profile,
    profileName: row.profileName,
    running: row.running,
    cdpReady: row.cdpReady,
    lastUsedAt: row.lastUsedAt,
    headless: row.headless,
    keepAliveMs: row.keepAliveMs,
    idleExpiresAt: row.idleExpiresAt,
    error: row.error,
  };
}

function sanitizeUrlForLog(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function browserResizeDimensions(payload: Record<string, unknown>): {
  width: number;
  height: number;
} {
  const width = toOptionalNumber(payload.width, { min: 1 });
  const height = toOptionalNumber(payload.height, { min: 1 });
  if (width === undefined || height === undefined) {
    throw new Error('browser_resize requires positive width and height');
  }
  return {
    width: Math.min(Math.trunc(width), MAX_HEADED_BROWSER_RESIZE_DIMENSION),
    height: Math.min(Math.trunc(height), MAX_HEADED_BROWSER_RESIZE_DIMENSION),
  };
}

function createBrowserIpcDeadline(
  timeoutMs: number | undefined,
  deadlineAtMs: number | undefined,
): BrowserIpcDeadline {
  if (typeof deadlineAtMs === 'number' && Number.isFinite(deadlineAtMs)) {
    return { deadlineAtMs: Math.trunc(deadlineAtMs) };
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return {};
  return { deadlineAtMs: nowMs() + Math.max(1, Math.trunc(timeoutMs)) };
}

function browserIpcRemainingMs(
  deadline: BrowserIpcDeadline,
): number | undefined {
  if (deadline.deadlineAtMs === undefined) return undefined;
  const remainingMs = Math.trunc(deadline.deadlineAtMs - nowMs());
  if (remainingMs <= 0) {
    throw new Error('Browser IPC deadline exceeded');
  }
  return remainingMs;
}

function browserCdpOptions(
  deadline: BrowserIpcDeadline,
): BrowserCdpTargetOptions | undefined {
  if (deadline.deadlineAtMs === undefined) return undefined;
  browserIpcRemainingMs(deadline);
  return { deadlineAtMs: deadline.deadlineAtMs };
}

function browserBackendTimeoutMs(
  deadline: BrowserIpcDeadline,
): number | undefined {
  const remainingMs = browserIpcRemainingMs(deadline);
  if (
    remainingMs !== undefined &&
    remainingMs < MIN_BROWSER_BACKEND_TIMEOUT_MS
  ) {
    throw new Error('Browser IPC deadline exceeded before backend dispatch');
  }
  return remainingMs;
}

async function inspectToolCapabilityBrokerHealth(
  context: BrowserContext,
): Promise<CredentialBrokerHealth | undefined> {
  if (!context.getCredentialBroker) return undefined;
  const brokerProfile = context.getCredentialBrokerProfile?.();
  if (!brokerProfile) return undefined;
  if (brokerProfile === 'none') {
    return {
      status: 'warn',
      message:
        'Credential broker mode is none; third-party MCP servers with credential refs cannot receive tool credentials.',
      nextAction:
        'Configure credential_broker in settings.yaml or use only credential-free MCP servers.',
    };
  }
  const broker = await context.getCredentialBroker();
  if (!broker) {
    return {
      status: 'warn',
      message:
        'Credential broker health is not available from this runtime process.',
      nextAction: 'Run `myclaw doctor` to verify credential broker settings.',
    };
  }
  return broker.healthCheck({
    binding: {
      profile: brokerProfile,
      purpose: 'tool_capability',
      agentIdentifier: memoryAgentIdForGroupFolder(context.sourceAgentFolder),
    },
  });
}

async function cachedToolCapabilityBrokerHealth(
  context: BrowserContext,
): Promise<CredentialBrokerHealth | undefined> {
  const brokerProfile = context.getCredentialBrokerProfile?.() || 'default';
  const cacheKey = `${context.sourceAgentFolder}:${brokerProfile}`;
  const cached = brokerHealthCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs()) return cached.value;
  const value = await inspectToolCapabilityBrokerHealth(context);
  if (value?.status !== 'fail') {
    brokerHealthCache.set(cacheKey, {
      value,
      expiresAt: nowMs() + BROKER_HEALTH_CACHE_MS,
    });
  }
  return value;
}

async function attachToolCapabilityBrokerHealth(
  data: unknown,
  context: BrowserContext,
): Promise<unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  let brokerHealth: CredentialBrokerHealth | undefined;
  try {
    brokerHealth = await cachedToolCapabilityBrokerHealth(context);
  } catch (err) {
    console.warn(
      'Credential broker health check failed during browser IPC status',
      {
        err,
        sourceAgentFolder: context.sourceAgentFolder,
      },
    );
    brokerHealth = {
      status: 'fail',
      message: 'Credential broker health check failed.',
      nextAction: 'Run `myclaw doctor` to verify credential broker settings.',
    };
  }
  if (!brokerHealth) return data;
  const next: BrowserStatusPayload = {
    ...(data as Record<string, unknown>),
    brokerHealthy: brokerHealth.status === 'pass',
    brokerHealth,
  };
  if (brokerHealth.status !== 'pass') {
    next.cdpReady = false;
    next.warning = [
      'Browser CDP is not driveable because the tool-capability credential broker is not healthy.',
      brokerHealth.nextAction,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return next;
}

async function handleBrowserToolAction(
  request: BrowserRequest,
  context: BrowserContext,
): Promise<BrowserResponse> {
  const deadline = createBrowserIpcDeadline(
    context.timeoutMs,
    context.deadlineAtMs,
  );
  const profileName = getProfileNameFromPayload(request.payload, context);
  switch (request.action) {
    case 'browser_status':
      return {
        ok: true,
        data: await attachToolCapabilityBrokerHealth(
          sanitizeBrowserStatus(await getBrowserStatus(profileName)),
          context,
        ),
      };
  }
  if (!context.browserIpcAuthorized) {
    return {
      ok: false,
      error:
        'Browser IPC is not authorized for this run. Select the canonical Browser capability before using browser actions.',
    };
  }
  switch (request.action) {
    case 'browser_launch': {
      browserIpcRemainingMs(deadline);
      const status = await ensureBrowserReady({
        profileName,
        headless: toOptionalBoolean(request.payload.headless),
        keepAliveMs: toOptionalNumber(request.payload.keep_alive_ms, {
          min: 10_000,
          max: 3_600_000,
        }),
        deadlineAtMs: deadline.deadlineAtMs,
      });
      return {
        ok: true,
        data: await attachToolCapabilityBrokerHealth(
          sanitizeBrowserStatus(status),
          context,
        ),
      };
    }
    case 'browser_close': {
      browserIpcRemainingMs(deadline);
      const closed = await closeBrowser(profileName);
      await context.closeBrowserToolBackends?.(profileName);
      return { ok: true, data: closed };
    }
  }

  browserIpcRemainingMs(deadline);
  const session = await ensureBrowserReady({
    profileName,
    deadlineAtMs: deadline.deadlineAtMs,
  });
  const cdpOptions = browserCdpOptions(deadline);
  const targetId = session.port
    ? cdpOptions
      ? await ensureBrowserTarget(session.port, cdpOptions)
      : await ensureBrowserTarget(session.port)
    : undefined;
  if (request.action === 'browser_resize' && session.headless === false) {
    if (!session.port || !targetId) {
      return {
        ok: false,
        error: 'Browser CDP target is unavailable for headed resize.',
      };
    }
    const { width, height } = browserResizeDimensions(request.payload);
    const resizeOptions = browserCdpOptions(deadline);
    if (resizeOptions) {
      await resizeHeadedBrowserWindow(
        session.port,
        targetId,
        width,
        height,
        resizeOptions,
      );
    } else {
      await resizeHeadedBrowserWindow(session.port, targetId, width, height);
    }
    return {
      ok: true,
      data: {
        content: [
          {
            type: 'text',
            text: `Browser window resized to ${width}x${height}.`,
          },
        ],
      },
    };
  }
  if (!context.callBrowserTool) {
    return {
      ok: false,
      error: 'Browser action backend is unavailable.',
    };
  }
  console.info('Browser tool action started', {
    sourceAgentFolder: context.sourceAgentFolder,
    profileName,
    toolName: request.action,
    url: sanitizeUrlForLog(request.payload.url),
  });
  if (
    session.port &&
    targetId &&
    FOREGROUND_BEFORE_DISPATCH_ACTIONS.has(request.action)
  ) {
    const foregroundOptions = browserCdpOptions(deadline);
    if (foregroundOptions) {
      await foregroundBrowserTarget(session.port, targetId, foregroundOptions);
    } else {
      await foregroundBrowserTarget(session.port, targetId);
    }
  }
  const backendTimeoutMs = browserBackendTimeoutMs(deadline);
  const result = await context.callBrowserTool({
    toolName: request.action,
    arguments: request.payload,
    session,
    fileAccessRoot: path.join(
      DATA_DIR,
      'sessions',
      context.sourceAgentFolder,
      'extra',
    ),
    timeoutMs: backendTimeoutMs,
  });
  console.info('Browser tool action completed', {
    sourceAgentFolder: context.sourceAgentFolder,
    profileName,
    toolName: request.action,
    url: sanitizeUrlForLog(request.payload.url),
  });
  return { ok: true, data: result };
}

export async function processBrowserIpcRequest(
  request: BrowserRequest,
  context: BrowserContext,
): Promise<BrowserResponse> {
  try {
    if (!BROWSER_IPC_ACTIONS.includes(request.action)) {
      return {
        ok: false,
        error: `Unsupported browser IPC action: ${String(request.action)}`,
      };
    }
    return await handleBrowserToolAction(request, context);
  } catch (err) {
    console.warn('Browser IPC request failed', {
      err,
      sourceAgentFolder: context.sourceAgentFolder,
      action: request.action,
      requestId: request.requestId,
    });
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Browser IPC request failed',
    };
  }
}

export function writeBrowserIpcResponse(
  ipcBaseDir: string,
  sourceAgentFolder: string,
  response: { requestId: string; ok: boolean; data?: unknown; error?: string },
  privateKeyPem?: string,
): void {
  const responseDir = path.join(
    ipcBaseDir,
    sourceAgentFolder,
    'browser-responses',
  );
  ensurePrivateDirSync(responseDir);
  const responsePath = path.join(responseDir, `${response.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  const payload: Record<string, unknown> = {
    ok: response.ok,
    requestId: response.requestId,
    ...(response.data !== undefined ? { data: response.data } : {}),
    ...(response.error ? { error: response.error } : {}),
  };
  const signature = signIpcResponsePayload(privateKeyPem, payload);
  if (!signature) return;
  payload.signature = signature;
  writePrivateFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, responsePath);
}
