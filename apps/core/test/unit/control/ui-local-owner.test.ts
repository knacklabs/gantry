import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  attachTrustedControlPrincipal,
  authenticate,
  type ApiKeyRecord,
} from '@core/control/server/auth.js';
import {
  LOCAL_OWNER_UI_SCOPES,
  resolveLocalOwnerUiState,
  validateLocalOwnerUiRequest,
} from '@core/control/server/ui-local-owner.js';

function key(scopes = [...LOCAL_OWNER_UI_SCOPES]): ApiKeyRecord {
  return {
    kid: 'ui-local-owner',
    tokenHash: createHash('sha256').update('local-token').digest(),
    appId: 'default',
    scopes: new Set(scopes),
  };
}

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveLocalOwnerUiState({
    enabled: 'true',
    keyId: 'ui-local-owner',
    host: '127.0.0.1',
    posture: {
      production: false,
      remoteControl: false,
      requiresProductionSecrets: false,
      requiresEnforcingSandbox: false,
    },
    processRole: 'all',
    routeProfile: 'full',
    keys: [key()],
    ...overrides,
  });
}

function request(input: {
  method?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
}): IncomingMessage {
  return {
    method: input.method ?? 'GET',
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1' },
  } as IncomingMessage;
}

describe('local-owner UI startup guard', () => {
  it('is disabled by default without requiring a key', () => {
    expect(resolve({ enabled: '', keyId: '', keys: [] })).toEqual({
      connectionMode: 'disabled',
      appId: 'default',
    });
  });

  it('resolves a fully scoped local key', () => {
    const state = resolve();
    expect(state.connectionMode).toBe('local-owner');
    expect(state.appId).toBe('default');
  });

  it.each([
    [
      'production posture',
      { posture: { production: true, requiresProductionSecrets: true } },
    ],
    ['remote host', { host: '0.0.0.0' }],
    ['worker role', { processRole: 'job-worker' }],
    ['ops routes', { routeProfile: 'ops' }],
  ])('fails closed for %s', (_label, overrides) => {
    expect(() => resolve(overrides)).toThrow('Local-owner UI preflight failed');
  });

  it('rejects a key missing any required UI scope', () => {
    expect(() => resolve({ keys: [key(['sessions:read'])] })).toThrow(
      'Control key is missing scopes',
    );
  });
});

describe('local-owner UI request guard', () => {
  const browserHeaders = {
    host: '127.0.0.1:3939',
    origin: 'http://127.0.0.1:3939',
    'x-gantry-ui-request': '1',
  };

  it('accepts an allowlisted same-origin loopback read', () => {
    expect(
      validateLocalOwnerUiRequest(
        request({ headers: browserHeaders }),
        '/v1/models',
      ),
    ).toBeUndefined();
  });

  it('allows the local runtime health read used by setup review', () => {
    expect(
      validateLocalOwnerUiRequest(
        request({ headers: browserHeaders }),
        '/v1/health',
      ),
    ).toBeUndefined();
  });

  it('allows the scoped provider discovery action', () => {
    const mutation = request({
      method: 'POST',
      headers: { ...browserHeaders },
    });
    mutation.headers['content-type'] = 'application/json';

    expect(
      validateLocalOwnerUiRequest(
        mutation,
        '/v1/provider-accounts/account-1/discover-conversations',
      ),
    ).toBeUndefined();
  });

  it('allows JSON provider-account creation without exposing account updates', () => {
    const mutation = request({
      method: 'POST',
      headers: { ...browserHeaders, 'content-type': 'application/json' },
    });

    expect(
      validateLocalOwnerUiRequest(mutation, '/v1/provider-accounts'),
    ).toBeUndefined();
    expect(
      validateLocalOwnerUiRequest(mutation, '/v1/provider-accounts/account-1'),
    ).toContain('not available');
  });

  it('allows JSON agent creation without exposing agent mutation routes', () => {
    const mutation = request({
      method: 'POST',
      headers: { ...browserHeaders, 'content-type': 'application/json' },
    });

    expect(validateLocalOwnerUiRequest(mutation, '/v1/agents')).toBeUndefined();
    expect(
      validateLocalOwnerUiRequest(mutation, '/v1/agents/agent-1/admin'),
    ).toContain('not available');
  });

  it('allows the scoped agent model selection action', () => {
    const mutation = request({
      method: 'PATCH',
      headers: { ...browserHeaders, 'content-type': 'application/json' },
    });

    expect(
      validateLocalOwnerUiRequest(mutation, '/v1/agents/agent-1/model'),
    ).toBeUndefined();
  });

  it('allows only the named profile files needed by agent setup', () => {
    const mutation = request({
      method: 'PUT',
      headers: { ...browserHeaders, 'content-type': 'application/json' },
    });

    expect(
      validateLocalOwnerUiRequest(
        mutation,
        '/v1/agents/agent-1/profile-files/soul',
      ),
    ).toBeUndefined();
    expect(
      validateLocalOwnerUiRequest(
        request({ headers: browserHeaders }),
        '/v1/agents/agent-1/profile-files/secret',
      ),
    ).toContain('not available');
  });

  it('rejects unlisted routes and cross-origin requests', () => {
    expect(
      validateLocalOwnerUiRequest(
        request({ headers: browserHeaders }),
        '/v1/settings/desired-state',
      ),
    ).toContain('not available');
    expect(
      validateLocalOwnerUiRequest(
        request({
          headers: { ...browserHeaders, origin: 'https://example.com' },
        }),
        '/v1/models',
      ),
    ).toContain('same-origin');
  });

  it('requires JSON for an allowlisted mutation', () => {
    const mutation = request({ method: 'PATCH', headers: browserHeaders });
    expect(
      validateLocalOwnerUiRequest(mutation, '/v1/models/defaults'),
    ).toContain('application/json');

    mutation.headers['content-type'] = 'application/json';
    expect(
      validateLocalOwnerUiRequest(mutation, '/v1/models/defaults'),
    ).toBeUndefined();
  });
});

describe('trusted Control principal', () => {
  it('uses the attached principal while preserving scope checks', () => {
    const req = request({});
    const principal = key(['sessions:read']);
    attachTrustedControlPrincipal(req, principal);

    expect(authenticate(req, ['sessions:read'], [])).toEqual({
      status: 'authenticated',
      key: principal,
    });
    expect(authenticate(req, ['jobs:read'], [])).toMatchObject({
      status: 'forbidden',
      missingScopes: ['jobs:read'],
    });
  });
});
