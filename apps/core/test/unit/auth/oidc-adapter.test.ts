import { expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { OidcAdapter } from '@core/adapters/auth/oidc-adapter.js';
import { hashAuthToken } from '@core/shared/auth-tokens.js';

it('OIDC adapter > rejects discovery with a mismatched issuer or insecure endpoints', async () => {
  const adapter = new OidcAdapter(
    async () =>
      new Response(
        JSON.stringify({
          issuer: 'https://other.example',
          authorization_endpoint: 'https://issuer.example/auth',
          token_endpoint: 'https://issuer.example/token',
          jwks_uri: 'https://issuer.example/jwks',
          id_token_signing_alg_values_supported: ['RS256'],
        }),
        { status: 200 },
      ),
  );
  await expect(adapter.discover('https://issuer.example')).rejects.toThrow(
    'OIDC discovery is invalid',
  );

  const insecureAdapter = new OidcAdapter(
    async () =>
      new Response(
        JSON.stringify({
          issuer: 'https://issuer.example',
          authorization_endpoint: 'https://issuer.example/auth',
          token_endpoint: 'http://issuer.example/token',
          jwks_uri: 'https://issuer.example/jwks',
          id_token_signing_alg_values_supported: ['RS256'],
        }),
        { status: 200 },
      ),
  );
  await expect(
    insecureAdapter.discover('https://issuer.example'),
  ).rejects.toThrow('OIDC discovery is invalid');

  const unsignedMetadataAdapter = new OidcAdapter(
    async () =>
      new Response(
        JSON.stringify({
          issuer: 'https://issuer.example',
          authorization_endpoint: 'https://issuer.example/auth',
          token_endpoint: 'https://issuer.example/token',
          jwks_uri: 'https://issuer.example/jwks',
        }),
        { status: 200 },
      ),
  );
  await expect(
    unsignedMetadataAdapter.discover('https://issuer.example'),
  ).rejects.toThrow('OIDC discovery is invalid');

  let requested = false;
  const unsafeIssuerAdapter = new OidcAdapter(async () => {
    requested = true;
    throw new Error('unexpected OIDC request');
  });
  const unsafeIssuer = new URL('https://issuer.example');
  unsafeIssuer.username = 'fixture-user';
  unsafeIssuer.password = 'fixture-password';
  await expect(
    unsafeIssuerAdapter.discover(unsafeIssuer.toString()),
  ).rejects.toThrow('OIDC discovery is invalid');
  expect(requested).toBe(false);

  const providerFailure = new OidcAdapter(async () => {
    throw new Error('provider implementation detail');
  });
  await expect(
    providerFailure.discover('https://issuer.example'),
  ).rejects.toThrow('OIDC discovery failed');
});

it('OIDC adapter > uses authorization-code PKCE and rejects malformed token responses', async () => {
  const adapter = new OidcAdapter(
    async () => new Response('{}', { status: 200 }),
  );
  const discovery = {
    issuer: 'https://issuer.example',
    authorization_endpoint: 'https://issuer.example/authorize',
    token_endpoint: 'https://issuer.example/token',
    jwks_uri: 'https://issuer.example/jwks',
    id_token_signing_alg_values_supported: ['RS256'],
  };
  const url = new URL(
    adapter.authorizationUrl({
      discovery,
      clientId: 'client',
      redirectUri: 'https://console.example/auth/oidc/callback',
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
    }),
  );
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  await expect(
    adapter.exchangeCode({
      discovery,
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://console.example/auth/oidc/callback',
      code: 'code',
      codeVerifier: 'verifier',
    }),
  ).rejects.toThrow('OIDC token response is invalid');
});

it('OIDC adapter > validates signed issuer, audience, expiry, and nonce claims', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  const adapter = new OidcAdapter(async (url) => {
    if (String(url) === 'https://issuer.example/jwks') {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    throw new Error('unexpected OIDC request');
  });
  const discovery = {
    issuer: 'https://issuer.example',
    authorization_endpoint: 'https://issuer.example/authorize',
    token_endpoint: 'https://issuer.example/token',
    jwks_uri: 'https://issuer.example/jwks',
    id_token_signing_alg_values_supported: ['RS256'],
  };
  const signedToken = async (
    claims: Record<string, unknown> = {},
    options: {
      issuer?: string;
      audience?: string | string[];
      authorizedParty?: string;
      includeExpiration?: boolean;
    } = {},
  ) => {
    const { exp, ...rest } = claims;
    let token = new SignJWT({
      sub: 'subject-1',
      nonce: 'expected-nonce',
      email: 'PERSON@EXAMPLE.COM ',
      email_verified: true,
      hd: 'EXAMPLE.COM',
      ...rest,
      ...(options.authorizedParty ? { azp: options.authorizedParty } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(options.issuer ?? discovery.issuer)
      .setAudience(options.audience ?? 'client')
      .setIssuedAt();
    if (options.includeExpiration !== false) {
      token = token.setExpirationTime(typeof exp === 'number' ? exp : '5m');
    }
    return token.sign(privateKey);
  };

  await expect(
    adapter.validateIdToken({
      token: await signedToken(),
      discovery,
      clientId: 'client',
      nonceHash: hashAuthToken('expected-nonce'),
    }),
  ).resolves.toMatchObject({
    subject: 'subject-1',
    email: 'person@example.com',
    emailVerified: true,
    hostedDomain: 'example.com',
  });
  await expect(
    adapter.validateIdToken({
      token: await signedToken({ nonce: 'wrong-nonce' }),
      discovery,
      clientId: 'client',
      nonceHash: hashAuthToken('expected-nonce'),
    }),
  ).rejects.toThrow('OIDC token claims are invalid');
  await expect(
    adapter.validateIdToken({
      token: await signedToken({}, { issuer: 'https://other.example' }),
      discovery,
      clientId: 'client',
      nonceHash: hashAuthToken('expected-nonce'),
    }),
  ).rejects.toThrow('OIDC token validation failed');
  await expect(
    adapter.validateIdToken({
      token: await signedToken({}, { audience: 'other-client' }),
      discovery,
      clientId: 'client',
      nonceHash: hashAuthToken('expected-nonce'),
    }),
  ).rejects.toThrow();
  await expect(
    adapter.validateIdToken({
      token: await signedToken(),
      discovery: {
        ...discovery,
        id_token_signing_alg_values_supported: ['PS256'],
      },
      clientId: 'client',
      nonceHash: hashAuthToken('expected-nonce'),
    }),
  ).rejects.toThrow();
  await expect(
    adapter.validateIdToken({
      token: await signedToken(
        {},
        {
          audience: ['client', 'other-client'],
          authorizedParty: 'other-client',
        },
      ),
      discovery,
      clientId: 'client',
      nonceHash: hashAuthToken('expected-nonce'),
    }),
  ).rejects.toThrow('OIDC token claims are invalid');
  await expect(
    adapter.validateIdToken({
      token: await signedToken({ exp: Math.floor(Date.now() / 1000) - 1 }),
      discovery,
      clientId: 'client',
      nonceHash: hashAuthToken('expected-nonce'),
    }),
  ).rejects.toThrow();
  await expect(
    adapter.validateIdToken({
      token: await signedToken({}, { includeExpiration: false }),
      discovery,
      clientId: 'client',
      nonceHash: hashAuthToken('expected-nonce'),
    }),
  ).rejects.toThrow();
});
