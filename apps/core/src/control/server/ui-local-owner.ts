import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProcessRole } from './system-health.js';
import type { ApiKeyRecord, Scope } from '../../shared/control-api-keys.js';
import type { RuntimeSecurityPosture } from '../../shared/security-posture.js';
import { isLocalControlHost } from '../../shared/security-posture.js';
import { sendError, sendJson } from './http.js';

export const LOCAL_OWNER_UI_SCOPES = [
  'sessions:read',
  'sessions:write',
  'jobs:read',
  'jobs:write',
  'memory:read',
  'memory:admin',
  'conversations:read',
  'conversations:admin',
  'messages:read',
  'providers:read',
  'providers:admin',
  'agents:admin',
  'credentials:read',
  'credentials:admin',
  'usage:read',
] as const satisfies readonly Scope[];

export type LocalOwnerUiState =
  | { connectionMode: 'disabled'; appId: 'default' }
  | {
      connectionMode: 'local-owner';
      appId: string;
      key: ApiKeyRecord;
    };

interface LocalOwnerUiInput {
  enabled: string;
  keyId: string;
  host: string;
  posture: RuntimeSecurityPosture;
  processRole: ProcessRole;
  routeProfile: 'full' | 'ops';
  keys: ApiKeyRecord[];
}

export function resolveLocalOwnerUiState(
  input: LocalOwnerUiInput,
): LocalOwnerUiState {
  const enabled = input.enabled.trim().toLowerCase();
  if (!enabled || enabled === 'false' || enabled === '0') {
    return { connectionMode: 'disabled', appId: 'default' };
  }
  if (enabled !== 'true' && enabled !== '1') {
    throw new Error(
      'GANTRY_UI_LOCAL_OWNER_ENABLED must be true, false, 1, or 0.',
    );
  }

  const failures: string[] = [];
  if (input.posture.production || input.posture.requiresProductionSecrets) {
    failures.push('production and remote security postures are forbidden');
  }
  if (!isLocalControlHost(input.host)) {
    failures.push('GANTRY_CONTROL_HOST must be loopback');
  }
  if (input.processRole !== 'all') {
    failures.push('GANTRY_PROCESS_ROLE must resolve to all');
  }
  if (input.routeProfile !== 'full') {
    failures.push('the full Control route profile is required');
  }

  const keyId = input.keyId.trim();
  if (!keyId) failures.push('GANTRY_UI_LOCAL_OWNER_KEY_ID is required');
  const key = input.keys.find((candidate) => candidate.kid === keyId);
  if (keyId && !key) failures.push(`Control key ${keyId} was not found`);
  if (key) {
    const missingScopes = LOCAL_OWNER_UI_SCOPES.filter(
      (scope) => !key.scopes.has(scope),
    );
    if (missingScopes.length > 0) {
      failures.push(
        `Control key is missing scopes: ${missingScopes.join(', ')}`,
      );
    }
  }

  if (failures.length > 0 || !key) {
    throw new Error(
      `Local-owner UI preflight failed:\n- ${failures.join('\n- ')}`,
    );
  }
  return { connectionMode: 'local-owner', appId: key.appId, key };
}

export function handleUiRuntimeConfig(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  state: LocalOwnerUiState,
): boolean {
  if (pathname !== '/ui/runtime-config.json') return false;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    connectionMode: state.connectionMode,
    apiBase: '/ui-api/v1',
    appId: state.appId,
  });
  return true;
}

export function validateLocalOwnerUiRequest(
  req: IncomingMessage,
  pathname: string,
): string | undefined {
  if (!isAllowedUiApiRoute(req.method ?? '', pathname)) {
    return 'This Control route is not available to the local UI.';
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return 'Local UI requests must originate from loopback.';
  }
  if (req.headers['x-gantry-ui-request'] !== '1') {
    return 'Missing local UI request marker.';
  }
  if (!isSameOriginRequest(req)) {
    return 'Local UI requests must be same-origin.';
  }
  if (isMutation(req.method) && !isJsonRequest(req)) {
    return 'Local UI mutations require application/json.';
  }
  return undefined;
}

function isAllowedUiApiRoute(method: string, pathname: string): boolean {
  const routeRules: Array<[RegExp, readonly string[]]> = [
    [/^\/v1\/health$/, ['GET']],
    [/^\/v1\/models$/, ['GET']],
    [/^\/v1\/models\/defaults$/, ['GET', 'PATCH']],
    [/^\/v1\/credentials\/models$/, ['GET']],
    [/^\/v1\/credentials\/models\/[^/]+$/, ['PUT', 'PATCH', 'DELETE']],
    [/^\/v1\/usage$/, ['GET']],
    [/^\/v1\/jobs$/, ['GET', 'POST']],
    [/^\/v1\/jobs\/[^/]+$/, ['GET', 'PATCH', 'DELETE']],
    [/^\/v1\/jobs\/[^/]+\/(?:pause|resume|trigger)$/, ['POST']],
    [/^\/v1\/jobs\/[^/]+\/events$/, ['GET']],
    [/^\/v1\/runs(?:\/[^/]+(?:\/events)?)?$/, ['GET']],
    [/^\/v1\/brain\/status$/, ['GET']],
    [/^\/v1\/memory$/, ['GET']],
    [/^\/v1\/memory\/search$/, ['POST']],
    [/^\/v1\/memory\/dreaming\/status$/, ['GET']],
    [/^\/v1\/memory\/dreaming\/trigger$/, ['POST']],
    [/^\/v1\/providers$/, ['GET']],
    [/^\/v1\/provider-accounts$/, ['GET', 'POST']],
    [/^\/v1\/provider-accounts\/[^/]+\/discover-conversations$/, ['POST']],
    [/^\/v1\/conversations$/, ['GET']],
    [/^\/v1\/conversations\/[^/]+$/, ['GET']],
    [/^\/v1\/conversations\/[^/]+\/(?:threads|messages)$/, ['GET']],
    [/^\/v1\/conversations\/[^/]+\/approvers$/, ['GET', 'PUT']],
    [/^\/v1\/agents$/, ['GET', 'POST']],
    [/^\/v1\/agents\/[^/]+$/, ['GET', 'PATCH']],
    [/^\/v1\/agent-setups$/, ['POST']],
    [/^\/v1\/agent-setups\/[^/]+$/, ['GET', 'PATCH', 'DELETE']],
    [/^\/v1\/agents\/[^/]+\/model$/, ['PATCH']],
    [/^\/v1\/agents\/[^/]+\/profile-files$/, ['GET']],
    [/^\/v1\/agents\/[^/]+\/profile-files\/(?:soul|agents)$/, ['GET', 'PUT']],
    [/^\/v1\/agents\/[^/]+\/conversation-installs$/, ['GET']],
    [
      /^\/v1\/agents\/[^/]+\/conversation-installs\/[^/]+$/,
      ['PUT', 'PATCH', 'DELETE'],
    ],
    [/^\/v1\/sessions\/ensure$/, ['POST']],
    [/^\/v1\/sessions\/[^/]+$/, ['GET']],
    [/^\/v1\/sessions\/[^/]+\/messages$/, ['GET', 'POST']],
    [/^\/v1\/sessions\/[^/]+\/(?:events|runs)$/, ['GET']],
  ];
  return routeRules.some(
    ([pattern, methods]) => pattern.test(pathname) && methods.includes(method),
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '::1' ||
    address === '127.0.0.1' ||
    address.startsWith('::ffff:127.')
  );
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const allowed = new Set([`http://${host}`, `https://${host}`]);
  const origin = req.headers.origin;
  if (origin) return allowed.has(origin);
  const referer = req.headers.referer;
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return req.headers['sec-fetch-site'] === 'same-origin';
}

function isMutation(method: string | undefined): boolean {
  return (
    method === 'POST' ||
    method === 'PUT' ||
    method === 'PATCH' ||
    method === 'DELETE'
  );
}

function isJsonRequest(req: IncomingMessage): boolean {
  return (
    req.headers['content-type']?.split(';', 1)[0]?.trim() === 'application/json'
  );
}
