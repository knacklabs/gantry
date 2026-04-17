import fs from 'fs';
import path from 'path';

import { BrowserIpcAction } from '@myclaw/contracts';

import { logger } from '../core/logger.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  closeBrowser,
  getBrowserStatus,
  launchBrowser,
} from './browser-manager.js';
import { createProfile } from './browser-profiles.js';
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

type BrowserContext = Pick<IpcDomainContext, 'sourceGroup' | 'isMain'>;
type BrowserActionHandler = (
  request: BrowserRequest,
  context: BrowserContext,
) => Promise<BrowserResponse>;

function toTrimmedString(
  value: unknown,
  opts: { maxLen?: number } = {},
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (opts.maxLen && trimmed.length > opts.maxLen) return undefined;
  return trimmed;
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

function getProfileNameFromPayload(payload: Record<string, unknown>): string {
  const requested = toTrimmedString(payload.profile_name, { maxLen: 64 });
  if (!requested) return DEFAULT_BROWSER_PROFILE_NAME;
  const normalized = requested.toLowerCase();
  if (normalized !== DEFAULT_BROWSER_PROFILE_NAME) {
    throw new Error(
      `Only browser profile "${DEFAULT_BROWSER_PROFILE_NAME}" is supported`,
    );
  }
  return normalized;
}

const browserActionHandlers: Record<BrowserIpcAction, BrowserActionHandler> = {
  browser_profile_list: async () => {
    const profile = createProfile(DEFAULT_BROWSER_PROFILE_NAME);
    const profiles = [
      {
        name: profile.name,
        created_at: profile.metadata.created_at,
        last_used: profile.metadata.last_used,
        cdp_port: profile.metadata.cdp_port,
        auth_markers: profile.metadata.auth_markers || [],
        has_state: fs.existsSync(profile.statePath),
      },
    ];
    return { ok: true, data: { profiles } };
  },
  browser_launch: async (request) => {
    const profileName = getProfileNameFromPayload(request.payload);
    const status = await launchBrowser({
      profileName,
      headless: toOptionalBoolean(request.payload.headless),
      cdpPort: toOptionalNumber(request.payload.cdp_port, {
        min: 1024,
        max: 65535,
      }),
      keepAliveMs: toOptionalNumber(request.payload.keep_alive_ms, {
        min: 10_000,
        max: 3_600_000,
      }),
    });
    return { ok: true, data: status };
  },
  browser_close: async (request) => {
    const profileName = getProfileNameFromPayload(request.payload);
    const closed = await closeBrowser(profileName);
    return { ok: true, data: closed };
  },
  browser_status: async (request) => {
    const profileName = getProfileNameFromPayload(request.payload);
    return { ok: true, data: getBrowserStatus(profileName) };
  },
};

export async function processBrowserIpcRequest(
  request: BrowserRequest,
  context: BrowserContext,
): Promise<BrowserResponse> {
  const mainOnlyActions = new Set<BrowserIpcAction>([
    'browser_profile_list',
    'browser_launch',
    'browser_close',
    'browser_status',
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
        sourceGroup: context.sourceGroup,
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
  sourceGroup: string,
  response: { requestId: string; ok: boolean; data?: unknown; error?: string },
): void {
  const responseDir = path.join(ipcBaseDir, sourceGroup, 'browser-responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${response.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        requestId: response.requestId,
        ok: response.ok,
        ...(response.data !== undefined ? { data: response.data } : {}),
        ...(response.error ? { error: response.error } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpPath, responsePath);
}
