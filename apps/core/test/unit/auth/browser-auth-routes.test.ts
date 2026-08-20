import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  expiredOidcStateCookie,
  oidcStateCookie,
  oidcStateMatches,
  parseOidcConfiguration,
} from '@core/control/server/browser-oidc.js';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

it('browser authentication routes > keeps browser protocol routes separate and replay-safe', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'apps/core/src/control/server/routes/browser-auth.ts'),
    'utf8',
  );
  const oidc = fs.readFileSync(
    path.join(repoRoot, 'apps/core/src/control/server/browser-oidc.ts'),
    'utf8',
  );

  expect(source).toContain("pathname === '/auth/local/authorize'");
  expect(source).toContain("pathname === '/auth/oidc/callback'");
  expect(source).toContain("pathname === '/auth/invitations/start'");
  expect(source).toContain("pathname === '/ui/api/auth/events'");
  expect(source).toContain('consumeLocalAuthorizationCode');
  expect(source).toContain('consumeOidcTransaction');
  expect(source).toContain('oidcStateMatches(');
  expect(source).toContain('expiredOidcStateCookie(');
  expect(oidc).toContain('const nonce = createOpaqueToken()');
  expect(oidc).toContain('nonceHash: hashAuthToken(nonce)');
  expect(oidc).toContain('? { oidcConfigJson: JSON.stringify(input.oidc) }');
  expect(oidc).toContain('configurationTest: input.configurationTest ?? false');
  expect(source).toContain(
    "target.searchParams.set('configuration-tested', '1')",
  );
  expect(source).toContain(
    "target.searchParams.set('configuration-test-failed', '1')",
  );
  expect(source).toContain(
    'reauthenticateSessionHash: hashAuthToken(sessionToken)',
  );
  expect(source).toContain('repo.revokeSession(');
  expect(source).toContain('transaction.reauthenticateSessionHash');
  expect(source).toContain(
    'sessionHash: transaction.reauthenticateSessionHash',
  );
  expect(source).toContain('OIDC reauthentication session is invalid');
  expect(source).toContain('RUNTIME_EVENT_TYPES.AUTH_INVITATION_ACCEPTED');
  expect(source).toContain('RUNTIME_EVENT_TYPES.AUTH_INVITATION_REVOKED');
  expect(source).toContain(
    'This authorization link can only be used on this Gantry host.',
  );
  expect(source).toContain('This invitation has already been used.');
  expect(source).toContain("pathname === '/ui/api/auth/invitations'");
  expect(source).toContain("method !== 'DELETE'");
  const invitationRoute = source
    .split("if (pathname === '/ui/api/auth/invitations')")[1]
    .split('const invitationMatch')[0];
  expect(invitationRoute).toContain("role === 'administrator'");
  expect(invitationRoute).toContain(
    '!isRecentlyReauthenticated(session.reauthenticatedAt)',
  );
  const candidateRoute = source.split(
    "if (pathname === '/ui/api/auth/config/candidate')",
  )[1];
  expect(candidateRoute).toContain('REAUTHENTICATION_REQUIRED');
  expect(candidateRoute).toContain('configurationTest: true');
  expect(candidateRoute).toContain('const flow = await beginOidcSignIn');
  expect(candidateRoute).toContain('redirectUrl: flow.authorizationUrl');

  expect(
    parseOidcConfiguration({
      issuer: ' https://issuer.example/ ',
      clientId: ' client ',
      clientSecretRef: 'env:GOOGLE_OIDC_CLIENT_SECRET',
      companyDomain: ' Example.COM ',
      providerLabel: ' Example ',
    }),
  ).toEqual({
    issuer: 'https://issuer.example',
    clientId: 'client',
    clientSecretRef: 'env:GOOGLE_OIDC_CLIENT_SECRET',
    companyDomain: 'example.com',
    providerLabel: 'Example',
  });
  const unsafeIssuer = new URL('https://issuer.example');
  unsafeIssuer.username = 'fixture-user';
  unsafeIssuer.password = 'fixture-password';
  expect(
    parseOidcConfiguration({
      issuer: unsafeIssuer.toString(),
      clientId: 'client',
      clientSecretRef: 'env:GOOGLE_OIDC_CLIENT_SECRET',
      companyDomain: 'example.com',
      providerLabel: 'Example',
    }),
  ).toBeNull();
  expect(
    parseOidcConfiguration({
      issuer: 'https://issuer.example',
      clientId: 'client',
      clientSecretRef: 'not-a-secret-ref',
      companyDomain: 'example.com',
      providerLabel: 'Example',
    }),
  ).toBeNull();

  const hostedStateCookie = oidcStateCookie(
    'https://console.example',
    'opaque-state',
  );
  expect(hostedStateCookie).toContain('__Host-gantry-oidc-state=opaque-state');
  expect(hostedStateCookie).toContain('HttpOnly; SameSite=Lax');
  expect(hostedStateCookie).toContain('Secure');
  expect(
    oidcStateMatches(
      hostedStateCookie,
      'https://console.example',
      'opaque-state',
    ),
  ).toBe(true);
  expect(
    oidcStateMatches(
      hostedStateCookie,
      'https://console.example',
      'other-state',
    ),
  ).toBe(false);
  expect(expiredOidcStateCookie('https://console.example')).toContain(
    'Max-Age=0; Secure',
  );
  const localStateCookie = oidcStateCookie(
    'http://127.0.0.1:3939',
    'local-state',
  );
  expect(localStateCookie).toContain('gantry_oidc_state=local-state');
  expect(localStateCookie).not.toContain('Secure');
  expect(
    oidcStateMatches(localStateCookie, 'http://127.0.0.1:3939', 'local-state'),
  ).toBe(true);
});
