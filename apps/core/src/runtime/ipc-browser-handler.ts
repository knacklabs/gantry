import fs from 'fs';
import path from 'path';

import { BrowserIpcAction } from '@myclaw/contracts';

import {
  signIpcResponseAuthPayload,
  signIpcResponsePayload,
} from '../infrastructure/ipc/response-signing.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  closeBrowser,
  ensureBrowserReady,
  getBrowserStatus,
  listBrowserProfiles,
} from './browser-capability.js';
import { IpcDomainContext } from './ipc-domain-types.js';

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
  'sourceAgentFolder' | 'isMain' | 'browserProfileName'
>;
type BrowserActionHandler = (
  request: BrowserRequest,
  context: BrowserContext,
) => Promise<BrowserResponse>;

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

function sanitizeBrowserProfiles(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const profile = row as Record<string, unknown>;
    return {
      name: profile.name,
      created_at: profile.created_at,
      last_used: profile.last_used,
      auth_markers: profile.auth_markers,
      has_state: profile.has_state,
      running: profile.running,
      cdpReady: profile.cdpReady,
    };
  });
}

const browserActionHandlers: Record<BrowserIpcAction, BrowserActionHandler> = {
  browser_profile_list: async () => {
    return {
      ok: true,
      data: { profiles: sanitizeBrowserProfiles(await listBrowserProfiles()) },
    };
  },
  browser_launch: async (request, context) => {
    const profileName = getProfileNameFromPayload(request.payload, context);
    const status = await ensureBrowserReady({
      profileName,
      headless: toOptionalBoolean(request.payload.headless),
      keepAliveMs: toOptionalNumber(request.payload.keep_alive_ms, {
        min: 10_000,
        max: 3_600_000,
      }),
    });
    return { ok: true, data: sanitizeBrowserStatus(status) };
  },
  browser_close: async (request, context) => {
    const profileName = getProfileNameFromPayload(request.payload, context);
    const closed = await closeBrowser(profileName);
    return { ok: true, data: closed };
  },
  browser_status: async (request, context) => {
    const profileName = getProfileNameFromPayload(request.payload, context);
    return {
      ok: true,
      data: sanitizeBrowserStatus(await getBrowserStatus(profileName)),
    };
  },
};

export async function processBrowserIpcRequest(
  request: BrowserRequest,
  context: BrowserContext,
): Promise<BrowserResponse> {
  const mainOnlyActions = new Set<BrowserIpcAction>([
    'browser_profile_list',
    'browser_close',
  ]);

  if (!context.isMain && mainOnlyActions.has(request.action)) {
    return {
      ok: false,
      error: `Browser action ${request.action} is restricted to the main group`,
    };
  }

  try {
    const handler = browserActionHandlers[request.action];
    if (!handler) {
      return {
        ok: false,
        error: `Unsupported browser action: ${String(request.action)}`,
      };
    }
    return await handler(request, context);
  } catch (err) {
    logger.warn(
      {
        err,
        sourceAgentFolder: context.sourceAgentFolder,
        action: request.action,
        requestId: request.requestId,
      },
      'Browser IPC request failed',
    );
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
  responseSigningKey?: string,
): void {
  const responseDir = path.join(
    ipcBaseDir,
    sourceAgentFolder,
    'browser-responses',
  );
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${response.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  const payload: Record<string, unknown> = {
    ok: response.ok,
    requestId: response.requestId,
    ...(response.data !== undefined ? { data: response.data } : {}),
    ...(response.error ? { error: response.error } : {}),
  };
  const signature =
    signIpcResponseAuthPayload(responseSigningKey, payload) ||
    signIpcResponsePayload(privateKeyPem, payload);
  if (signature) {
    payload.signature = signature;
  }
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, responsePath);
}
