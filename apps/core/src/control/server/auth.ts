import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isValidControlId } from '../../application/app-scope/control-id.js';

export type Scope =
  | 'sessions:read'
  | 'sessions:write'
  | 'jobs:read'
  | 'jobs:write'
  | 'channels:read'
  | 'channels:admin'
  | 'conversations:read'
  | 'messages:read'
  | 'agents:admin'
  | 'skills:read'
  | 'skills:admin'
  | 'mcp:read'
  | 'mcp:admin'
  | 'webhooks:read'
  | 'webhooks:write'
  | 'ingresses:read'
  | 'ingresses:write'
  | 'memory:read'
  | 'memory:write'
  | 'memory:admin';

export type ApiKeyRecord = {
  kid: string;
  tokenHash: Buffer;
  scopes: Set<Scope>;
  appId: string;
};

const ALL_SCOPES: Scope[] = [
  'sessions:read',
  'sessions:write',
  'jobs:read',
  'jobs:write',
  'channels:read',
  'channels:admin',
  'conversations:read',
  'messages:read',
  'agents:admin',
  'skills:read',
  'skills:admin',
  'mcp:read',
  'mcp:admin',
  'webhooks:read',
  'webhooks:write',
  'ingresses:read',
  'ingresses:write',
  'memory:read',
  'memory:write',
  'memory:admin',
];

export { isValidControlId };

function isApiKeyJsonEntry(value: unknown): value is {
  kid?: string;
  token?: string;
  scopes?: string[];
  appId?: string;
} {
  return Boolean(value && typeof value === 'object');
}

export function parseControlApiKeys(input: {
  rawJson?: string;
  rawSingle?: string;
  singleAppId?: string;
}): ApiKeyRecord[] {
  const rawJson = input.rawJson?.trim() || '';
  const rawSingle = input.rawSingle?.trim() || '';
  const singleAppId = input.singleAppId?.trim() || '';
  if (rawJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isApiKeyJsonEntry)
      .filter((entry) => entry.kid && entry.token)
      .map((entry) => ({
        kid: String(entry.kid),
        tokenHash: createHash('sha256').update(String(entry.token)).digest(),
        scopes: new Set(
          (entry.scopes || []).filter((scope: string): scope is Scope =>
            ALL_SCOPES.includes(scope as Scope),
          ),
        ),
        appId: typeof entry.appId === 'string' ? entry.appId.trim() : '',
      }))
      .filter((entry) => isValidControlId(entry.appId));
  }
  if (rawSingle && isValidControlId(singleAppId)) {
    return [
      {
        kid: 'default',
        tokenHash: createHash('sha256').update(rawSingle).digest(),
        scopes: new Set(ALL_SCOPES),
        appId: singleAppId,
      },
    ];
  }
  return [];
}

export function authenticate(
  req: IncomingMessage,
  requiredScopes: Scope[],
  keys: ApiKeyRecord[],
): ApiKeyRecord | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  const provided = createHash('sha256').update(token).digest();
  for (const key of keys) {
    if (
      key.tokenHash.length === provided.length &&
      timingSafeEqual(key.tokenHash, provided)
    ) {
      const missing = requiredScopes.some((scope) => !key.scopes.has(scope));
      if (!missing) return key;
    }
  }
  return null;
}
