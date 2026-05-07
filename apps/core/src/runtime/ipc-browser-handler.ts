import fs from 'fs';
import path from 'path';

import { BrowserIpcAction } from '@myclaw/contracts';

import {
  signIpcResponseAuthPayload,
  signIpcResponsePayload,
} from '../infrastructure/ipc/response-signing.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  closeBrowser,
  ensureBrowserReady,
  getBrowserStatus,
  listBrowserProfiles,
} from './browser-capability.js';
import { IpcDomainContext } from './ipc-domain-types.js';
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
  'sourceAgentFolder' | 'isMain' | 'browserProfileName'
> & {
  getCredentialBroker?: IpcDomainContext['deps']['getCredentialBroker'];
  getCredentialBrokerProfile?: IpcDomainContext['deps']['getCredentialBrokerProfile'];
};
type BrowserStatusPayload = Record<string, unknown> & {
  brokerHealthy?: boolean;
  brokerHealth?: CredentialBrokerHealth;
  warning?: string;
};
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

async function attachToolCapabilityBrokerHealth(
  data: unknown,
  context: BrowserContext,
): Promise<unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  let brokerHealth: CredentialBrokerHealth | undefined;
  try {
    brokerHealth = await inspectToolCapabilityBrokerHealth(context);
  } catch (err) {
    logger.warn(
      { err, sourceAgentFolder: context.sourceAgentFolder },
      'Credential broker health check failed during browser IPC status',
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
    next.warning = [
      'Browser CDP may be ready, but third-party MCP tools can fail because the tool-capability credential broker is not healthy.',
      brokerHealth.nextAction,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return next;
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
    return {
      ok: true,
      data: await attachToolCapabilityBrokerHealth(
        sanitizeBrowserStatus(status),
        context,
      ),
    };
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
      data: await attachToolCapabilityBrokerHealth(
        sanitizeBrowserStatus(await getBrowserStatus(profileName)),
        context,
      ),
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
  ensurePrivateDirSync(responseDir);
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
  writePrivateFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, responsePath);
}
