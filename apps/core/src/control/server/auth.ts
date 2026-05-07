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

export type AuthenticationResult =
  | { status: 'authenticated'; key: ApiKeyRecord }
  | { status: 'missing' | 'invalid' }
  | { status: 'forbidden'; key: ApiKeyRecord; missingScopes: Scope[] };

const ALL_SCOPES: Scope[] = [
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

export function parseControlApiKeysStrict(input: {
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
    } catch (err) {
      throw new Error('MYCLAW_CONTROL_API_KEYS_JSON must be valid JSON.', {
        cause: err,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new Error('MYCLAW_CONTROL_API_KEYS_JSON must be a JSON array.');
    }
    return parsed.map((entry, index) => {
      if (!isApiKeyJsonEntry(entry)) {
        throw new Error(
          `MYCLAW_CONTROL_API_KEYS_JSON[${index}] must be an object.`,
        );
      }
      const kid = entry.kid?.trim() || '';
      const token = entry.token?.trim() || '';
      const appId = entry.appId?.trim() || '';
      if (!kid) {
        throw new Error(
          `MYCLAW_CONTROL_API_KEYS_JSON[${index}].kid is required.`,
        );
      }
      if (!token) {
        throw new Error(
          `MYCLAW_CONTROL_API_KEYS_JSON[${index}].token is required.`,
        );
      }
      if (!isValidControlId(appId)) {
        throw new Error(
          `MYCLAW_CONTROL_API_KEYS_JSON[${index}].appId must be a valid control id.`,
        );
      }
      if (!Array.isArray(entry.scopes)) {
        throw new Error(
          `MYCLAW_CONTROL_API_KEYS_JSON[${index}].scopes must be an array.`,
        );
      }
      const invalidScopes = entry.scopes.filter(
        (scope) => !ALL_SCOPES.includes(scope as Scope),
      );
      if (invalidScopes.length > 0) {
        throw new Error(
          `MYCLAW_CONTROL_API_KEYS_JSON[${index}].scopes contains unsupported scope ${String(
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
  if (rawSingle) {
    if (!isValidControlId(singleAppId)) {
      throw new Error(
        'MYCLAW_CONTROL_APP_ID is required and must be a valid control id when MYCLAW_CONTROL_API_KEY is set.',
      );
    }
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
