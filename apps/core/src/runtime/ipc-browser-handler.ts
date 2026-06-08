import fs from 'fs';
import path from 'path';

import {
  BROWSER_BACKEND_ACTIONS,
  type BrowserBackendAction,
} from '../shared/browser-backend-actions.js';

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
  beginBrowserUsage,
  finishBrowserUsage,
  rememberBrowserUsageSite,
} from './browser-usage-governor.js';
import {
  type BrowserCdpTargetOptions,
  ensureBrowserTarget,
  foregroundBrowserTarget,
} from './browser-cdp-targets.js';
import {
  browserUsagePayloadUrl,
  resolveActiveBrowserUrlForUsage,
} from './browser-usage-active-site.js';
import { type IpcDomainContext } from './ipc-domain-types.js';
import { resolveBrowserFileAttachPayload } from './browser-file-attach-source.js';

interface BrowserRequest {
  requestId: string;
  action: BrowserBackendAction;
  payload: Record<string, unknown>;
  jobId?: string;
  runId?: string;
  appId?: string;
  agentId?: string;
  publicToolName?: string;
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
  getFileArtifactStore?: IpcDomainContext['deps']['getFileArtifactStore'];
  callBrowserTool?: IpcDomainContext['deps']['callBrowserTool'];
  publishBrowserJobActivity?: IpcDomainContext['deps']['publishBrowserJobActivity'];
  closeBrowserToolBackends?: IpcDomainContext['deps']['closeBrowserToolBackends'];
  getBrowserUsageSettings?: IpcDomainContext['deps']['getBrowserUsageSettings'];
  timeoutMs?: number;
  deadlineAtMs?: number;
};
const MIN_BROWSER_BACKEND_TIMEOUT_MS = 1_000;
const MAX_BROWSER_RESIZE_DIMENSION = 8_192;
const BROWSER_IPC_UNAUTHORIZED_ERROR =
  'Browser IPC is not authorized for this run. Select the canonical Browser capability before using browser actions.';
const POINTER_ACTIONS = new Set<BrowserBackendAction>([
  'click',
  'hover',
  'drag',
  'drop',
  'select_option',
  'fill_form',
  'file_attach',
]);
const FOREGROUND_BEFORE_DISPATCH_ACTIONS = new Set<BrowserBackendAction>([
  ...POINTER_ACTIONS,
  'screenshot',
]);

interface BrowserIpcDeadline {
  deadlineAtMs?: number;
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

function assertPayloadKeys(
  action: BrowserBackendAction,
  payload: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${action} does not support payload field(s): ${unknown.sort().join(', ')}`,
    );
  }
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
    profilePersistent: row.profilePersistent,
    userDataDir: row.userDataDir,
    chromeExecutable: row.chromeExecutable,
    hasState: row.hasState,
    authMarkers: row.authMarkers,
    error: row.error,
  };
}

function browserResizeDimensions(payload: Record<string, unknown>): {
  width: number;
  height: number;
} {
  const width = toOptionalNumber(payload.width, { min: 1 });
  const height = toOptionalNumber(payload.height, { min: 1 });
  if (width === undefined || height === undefined) {
    throw new Error('resize requires positive width and height');
  }
  return {
    width: Math.min(Math.trunc(width), MAX_BROWSER_RESIZE_DIMENSION),
    height: Math.min(Math.trunc(height), MAX_BROWSER_RESIZE_DIMENSION),
  };
}

function browserToolResultIsError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { isError?: unknown }).isError === true
  );
}

function browserToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const row = item as Record<string, unknown>;
      return row.type === 'text' && typeof row.text === 'string'
        ? row.text
        : undefined;
    })
    .filter((item): item is string => !!item)
    .join('\n')
    .trim();
  return text || undefined;
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

async function callBrowserResizeBackend(input: {
  context: BrowserContext;
  session: Awaited<ReturnType<typeof ensureBrowserReady>>;
  width: number;
  height: number;
  deadline: BrowserIpcDeadline;
}): Promise<void> {
  if (!input.context.callBrowserTool) {
    throw new Error(
      'Browser action backend is unavailable for viewport resize.',
    );
  }
  const backendTimeoutMs = browserBackendTimeoutMs(input.deadline);
  const result = await input.context.callBrowserTool({
    toolName: 'resize',
    arguments: { width: input.width, height: input.height },
    session: input.session,
    fileAccessRoot: path.join(
      DATA_DIR,
      'sessions',
      input.context.sourceAgentFolder,
      'extra',
    ),
    timeoutMs: backendTimeoutMs,
  });
  if (browserToolResultIsError(result)) {
    throw new Error(
      browserToolResultText(result) || 'Browser viewport resize failed.',
    );
  }
}

async function getBrowserUsageSettings(context: BrowserContext) {
  return context.getBrowserUsageSettings
    ? await context.getBrowserUsageSettings()
    : undefined;
}

async function handleBrowserToolActionInner(
  request: BrowserRequest,
  context: BrowserContext,
  profileName: string,
): Promise<BrowserResponse> {
  const deadline = createBrowserIpcDeadline(
    context.timeoutMs,
    context.deadlineAtMs,
  );
  switch (request.action) {
    case 'status':
      return {
        ok: true,
        data: sanitizeBrowserStatus(await getBrowserStatus(profileName)),
      };
  }
  if (!context.browserIpcAuthorized) {
    return {
      ok: false,
      error: BROWSER_IPC_UNAUTHORIZED_ERROR,
    };
  }
  switch (request.action) {
    case 'open': {
      assertPayloadKeys(request.action, request.payload, [
        'profile_name',
        'keep_alive_ms',
      ]);
      browserIpcRemainingMs(deadline);
      const launchOptions = {
        profileName,
        keepAliveMs: toOptionalNumber(request.payload.keep_alive_ms, {
          min: 10_000,
          max: 3_600_000,
        }),
        deadlineAtMs: deadline.deadlineAtMs,
      };
      const status = await ensureBrowserReady(launchOptions);
      return {
        ok: true,
        data: sanitizeBrowserStatus(status),
      };
    }
    case 'close': {
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
  if (request.action === 'resize') {
    const { width, height } = browserResizeDimensions(request.payload);
    if (session.port) {
      const resizeTargetOptions = browserCdpOptions(deadline);
      if (resizeTargetOptions) {
        await ensureBrowserTarget(session.port, resizeTargetOptions);
      } else {
        await ensureBrowserTarget(session.port);
      }
    }
    await callBrowserResizeBackend({
      context,
      session,
      width,
      height,
      deadline,
    });
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
  const cdpOptions = browserCdpOptions(deadline);
  const targetId = session.port
    ? cdpOptions
      ? await ensureBrowserTarget(session.port, cdpOptions)
      : await ensureBrowserTarget(session.port)
    : undefined;
  if (!context.callBrowserTool) {
    return {
      ok: false,
      error: 'Browser action backend is unavailable.',
    };
  }
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
  const fileAccessRoot = path.join(
    DATA_DIR,
    'sessions',
    context.sourceAgentFolder,
    'extra',
  );
  const backendPayload = await resolveBrowserFileAttachPayload({
    request,
    sourceAgentFolder: context.sourceAgentFolder,
    getFileArtifactStore: context.getFileArtifactStore,
  });
  const result = await context.callBrowserTool({
    toolName: request.action,
    arguments: backendPayload,
    session,
    fileAccessRoot,
    timeoutMs: backendTimeoutMs,
  });
  return { ok: true, data: result };
}

async function handleBrowserToolAction(
  request: BrowserRequest,
  context: BrowserContext,
): Promise<BrowserResponse> {
  const profileName = getProfileNameFromPayload(request.payload, context);
  if (request.action !== 'status' && !context.browserIpcAuthorized) {
    return {
      ok: false,
      error: BROWSER_IPC_UNAUTHORIZED_ERROR,
    };
  }
  const fileAccessRoot = path.join(
    DATA_DIR,
    'sessions',
    context.sourceAgentFolder,
    'extra',
  );
  const usageSettings = await getBrowserUsageSettings(context);
  const activeUrl = await resolveActiveBrowserUrlForUsage({
    action: request.action,
    payload: request.payload,
    browserIpcAuthorized: context.browserIpcAuthorized,
    profileName,
    settings: usageSettings,
    timeoutMs: context.timeoutMs,
    deadlineAtMs: context.deadlineAtMs,
    sourceAgentFolder: context.sourceAgentFolder,
    callBrowserTool: context.callBrowserTool,
    fileAccessRoot,
  });
  const payloadUrl = browserUsagePayloadUrl(request.action, request.payload);
  const usageDecision = beginBrowserUsage({
    action: request.action,
    payload: request.payload,
    profileName,
    settings: usageSettings,
    payloadUrl: payloadUrl ?? null,
    activeUrl,
  });
  const startedAt = nowMs();
  let response: BrowserResponse | undefined;
  try {
    if (!usageDecision.allowed) {
      response = {
        ok: false,
        error:
          usageDecision.warning || 'Browser usage policy denied this action.',
      };
      return response;
    }
    response = await handleBrowserToolActionInner(
      request,
      context,
      profileName,
    );
    rememberBrowserUsageSite({
      action: request.action,
      payload: request.payload,
      profileName,
      ok: response.ok,
      payloadUrl: payloadUrl ?? null,
      activeUrl,
    });
    return response;
  } finally {
    finishBrowserUsage(usageDecision);
    console.info('Browser tool action audit', {
      sourceAgentFolder: context.sourceAgentFolder,
      jobId: request.jobId,
      runId: request.runId,
      profileName,
      toolName: request.action,
      normalizedSite: usageDecision.normalizedSite,
      policyMode: usageDecision.policyMode,
      warning: usageDecision.warning,
      elapsedMs: nowMs() - startedAt,
      ok: response?.ok ?? false,
      result: response?.ok ? 'success' : 'error',
    });
    await publishBrowserJobActivity({
      request,
      publish: context.publishBrowserJobActivity,
      elapsedMs: nowMs() - startedAt,
      ok: response?.ok ?? false,
      normalizedSite: usageDecision.normalizedSite,
      policyMode: usageDecision.policyMode,
      warning: usageDecision.warning,
      error: response?.ok ? undefined : response?.error,
    });
  }
}

async function publishBrowserJobActivity(input: {
  request: BrowserRequest;
  publish?: IpcDomainContext['deps']['publishBrowserJobActivity'];
  elapsedMs: number;
  ok: boolean;
  normalizedSite?: string | null;
  policyMode?: string;
  warning?: string;
  error?: string;
}): Promise<void> {
  if (!input.request.jobId || !input.request.runId || !input.publish) return;
  try {
    await input.publish({
      jobId: input.request.jobId,
      runId: input.request.runId,
      tool: 'Browser',
      publicToolName: input.request.publicToolName,
      action: input.request.action,
      ok: input.ok,
      elapsedMs: input.elapsedMs,
      normalizedSite: input.normalizedSite ?? null,
      policyMode: input.policyMode ?? null,
      warning: input.warning ?? null,
      error: input.error ?? null,
    });
  } catch (err) {
    console.warn('Failed to publish browser job activity', {
      err,
      jobId: input.request.jobId,
      runId: input.request.runId,
    });
  }
}

export async function processBrowserIpcRequest(
  request: BrowserRequest,
  context: BrowserContext,
): Promise<BrowserResponse> {
  try {
    if (!BROWSER_BACKEND_ACTIONS.includes(request.action)) {
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
