import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isValidControlId } from '../../application/app-scope/control-id.js';

export type Scope =
  | 'sessions:read'
  | 'sessions:write'
  | 'jobs:read'
  | 'jobs:write'
  | 'providers:read'
  | 'providers:admin'
  | 'conversations:read'
  | 'conversations:admin'
  | 'messages:read'
  | 'agents:admin'
  | 'credentials:read'
  | 'credentials:admin'
  | 'skills:read'
  | 'skills:admin'
  | 'mcp:read'
  | 'mcp:admin'
  | 'webhooks:read'
  | 'webhooks:write'
  | 'ingresses:read'
  | 'ingresses:write'
  | 'memory:read'
  | 'memory:admin';

export type ApiKeyRecord = {
  kid: string;
  tokenHash: Buffer;
  scopes: Set<Scope>;
  appId: string;
};

export type AuthenticationResult =
  | { status: 'authenticated'; key: ApiKeyRecord }
  | { status: 'missing' | 'invalid' }
  | { status: 'forbidden'; key: ApiKeyRecord; missingScopes: Scope[] };

export const CONTROL_API_SCOPES: readonly Scope[] = [
  'sessions:read',
  'sessions:write',
  'jobs:read',
  'jobs:write',
  'providers:read',
  'providers:admin',
  'conversations:read',
  'conversations:admin',
  'messages:read',
  'agents:admin',
  'credentials:read',
  'credentials:admin',
  'skills:read',
  'skills:admin',
  'mcp:read',
  'mcp:admin',
  'webhooks:read',
  'webhooks:write',
  'ingresses:read',
  'ingresses:write',
  'memory:read',
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
}): ApiKeyRecord[] {
  const rawJson = input.rawJson?.trim() || '';
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
            CONTROL_API_SCOPES.includes(scope as Scope),
          ),
        ),
        appId: typeof entry.appId === 'string' ? entry.appId.trim() : '',
      }))
      .filter((entry) => isValidControlId(entry.appId));
  }
  return [];
}

export function parseControlApiKeysStrict(input: {
  rawJson?: string;
}): ApiKeyRecord[] {
  const rawJson = input.rawJson?.trim() || '';
  if (rawJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      throw new Error('GANTRY_CONTROL_API_KEYS_JSON must be valid JSON.', {
        cause: err,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new Error('GANTRY_CONTROL_API_KEYS_JSON must be a JSON array.');
    }
    return parsed.map((entry, index) => {
      if (!isApiKeyJsonEntry(entry)) {
        throw new Error(
          `GANTRY_CONTROL_API_KEYS_JSON[${index}] must be an object.`,
        );
      }
      const kid = entry.kid?.trim() || '';
      const token = entry.token?.trim() || '';
      const appId = entry.appId?.trim() || '';
      if (!kid) {
        throw new Error(
          `GANTRY_CONTROL_API_KEYS_JSON[${index}].kid is required.`,
        );
      }
      if (!token) {
        throw new Error(
          `GANTRY_CONTROL_API_KEYS_JSON[${index}].token is required.`,
        );
      }
      if (!isValidControlId(appId)) {
        throw new Error(
          `GANTRY_CONTROL_API_KEYS_JSON[${index}].appId must be a valid control id.`,
        );
      }
      if (!Array.isArray(entry.scopes)) {
        throw new Error(
          `GANTRY_CONTROL_API_KEYS_JSON[${index}].scopes must be an array.`,
        );
      }
      const invalidScopes = entry.scopes.filter(
        (scope) => !CONTROL_API_SCOPES.includes(scope as Scope),
      );
      if (invalidScopes.length > 0) {
        throw new Error(
          `GANTRY_CONTROL_API_KEYS_JSON[${index}].scopes contains unsupported scope ${String(
            invalidScopes[0],
          )}.`,
        );
      }
      return {
        kid,
        tokenHash: createHash('sha256').update(token).digest(),
        scopes: new Set(entry.scopes as Scope[]),
        appId,
      };
    });
  }
  return [];
}

export function authenticate(
  req: IncomingMessage,
  requiredScopes: Scope[],
  keys: ApiKeyRecord[],
): AuthenticationResult {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return { status: 'missing' };
  const token = header.slice('Bearer '.length).trim();
  if (!token) return { status: 'missing' };
  const provided = createHash('sha256').update(token).digest();
  for (const key of keys) {
    if (
      key.tokenHash.length === provided.length &&
      timingSafeEqual(key.tokenHash, provided)
    ) {
      const missingScopes = requiredScopes.filter(
        (scope) => !key.scopes.has(scope),
      );
      if (missingScopes.length === 0) {
        return { status: 'authenticated', key };
      }
      return { status: 'forbidden', key, missingScopes };
    }
  }
  return { status: 'invalid' };
}
