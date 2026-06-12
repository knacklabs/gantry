import { createHash } from 'node:crypto';

import { isValidControlId } from './control-id.js';
import { isStrongProductionSecret } from './secret-strength.js';

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
  if (!rawJson) return [];
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

export function parseControlApiKeysStrict(input: {
  rawJson?: string;
  requireStrongTokens?: boolean;
  requireNonEmptyScopes?: boolean;
}): ApiKeyRecord[] {
  const rawJson = input.rawJson?.trim() || '';
  if (!rawJson) return [];
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
  const seenKids = new Set<string>();
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
    if (input.requireStrongTokens && !isStrongProductionSecret(token)) {
      throw new Error(
        `GANTRY_CONTROL_API_KEYS_JSON[${index}].token must be at least 32 characters of non-trivial secret material for production or remote control mode.`,
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
    if (seenKids.has(kid)) {
      throw new Error(
        `GANTRY_CONTROL_API_KEYS_JSON[${index}].kid duplicates another key.`,
      );
    }
    seenKids.add(kid);
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
    if (input.requireNonEmptyScopes && entry.scopes.length === 0) {
      throw new Error(
        `GANTRY_CONTROL_API_KEYS_JSON[${index}].scopes must include at least one scope for production or remote control mode.`,
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
