import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

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
  | 'webhooks:read'
  | 'webhooks:write'
  | 'memory:read'
  | 'memory:write'
  | 'memory:admin';

export type ApiKeyRecord = {
  kid: string;
  tokenHash: Buffer;
  scopes: Set<Scope>;
  appId: string;
};

const CONTROL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
  'webhooks:read',
  'webhooks:write',
  'memory:read',
  'memory:write',
  'memory:admin',
];

export function isValidControlId(value: string): boolean {
  return CONTROL_ID_PATTERN.test(value);
}

export function parseControlApiKeys(): ApiKeyRecord[] {
  const rawJson = process.env.MYCLAW_CONTROL_API_KEYS_JSON?.trim();
  const rawSingle = process.env.MYCLAW_CONTROL_API_KEY?.trim();
  const singleAppId = process.env.MYCLAW_CONTROL_APP_ID?.trim() || '';
  if (rawJson) {
    const parsed = JSON.parse(rawJson) as Array<{
      kid?: string;
      token?: string;
      scopes?: string[];
      appId?: string;
    }>;
    return parsed
      .filter((entry) => entry.kid && entry.token)
      .map((entry) => ({
        kid: String(entry.kid),
        tokenHash: createHash('sha256').update(String(entry.token)).digest(),
        scopes: new Set(
          (entry.scopes || []).filter((scope): scope is Scope =>
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
