import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

describe('browser authentication routes', () => {
  it('keeps browser protocol routes separate and replay-safe', () => {
    const source = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/control/server/routes/browser-auth.ts',
      ),
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
    expect(oidc).toContain('const nonce = createOpaqueToken()');
    expect(oidc).toContain('nonceHash: hashAuthToken(nonce)');
    expect(oidc).toContain('? { oidcConfigJson: JSON.stringify(input.oidc) }');
    expect(oidc).toContain(
      'configurationTest: input.configurationTest ?? false',
    );
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
      'This authorization link can only be used on this Gantry host.',
    );
    expect(source).toContain('This invitation has already been used.');
    expect(source).toContain("pathname === '/ui/api/auth/invitations'");
    expect(source).toContain("method !== 'DELETE'");
    const candidateRoute = source.split(
      "if (pathname === '/ui/api/auth/config/candidate')",
    )[1];
    expect(candidateRoute).toContain('REAUTHENTICATION_REQUIRED');
    expect(candidateRoute).toContain('configurationTest: true');
    expect(candidateRoute).toContain('redirectUrl: await beginOidcSignIn');
  });
});
