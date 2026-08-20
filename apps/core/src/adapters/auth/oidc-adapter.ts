import { createHash } from 'node:crypto';

import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

import { hashAuthToken } from '../../shared/auth-tokens.js';

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type VerifiedOidcIdentity = {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  hostedDomain?: string;
};

export type OidcTokenResponse = {
  idToken: string;
};

export class OidcAdapter {
  /** The runtime must pass the existing DNS-pinned outbound transport. */
  constructor(private readonly fetcher: typeof fetch) {}

  async discover(issuer: string): Promise<OidcDiscovery> {
    const normalizedIssuer = issuer.replace(/\/$/, '');
    const response = await this.fetcher(
      `${normalizedIssuer}/.well-known/openid-configuration`,
    );
    if (!response.ok) throw new Error('OIDC discovery failed');
    const discovery = (await response.json()) as Partial<OidcDiscovery>;
    if (
      discovery.issuer !== normalizedIssuer ||
      !discovery.authorization_endpoint ||
      !discovery.token_endpoint ||
      !discovery.jwks_uri
    )
      throw new Error('OIDC discovery is invalid');
    return discovery as OidcDiscovery;
  }

  async validateIdToken(input: {
    token: string;
    discovery: OidcDiscovery;
    clientId: string;
    nonceHash: string;
  }): Promise<VerifiedOidcIdentity> {
    const jwks = createRemoteJWKSet(new URL(input.discovery.jwks_uri), {
      [customFetch]: this.fetcher,
    });
    const { payload } = await jwtVerify(input.token, jwks, {
      issuer: input.discovery.issuer,
      audience: input.clientId,
    });
    if (
      typeof payload.nonce !== 'string' ||
      hashAuthToken(payload.nonce) !== input.nonceHash ||
      typeof payload.sub !== 'string' ||
      !payload.sub
    )
      throw new Error('OIDC token claims are invalid');
    return {
      issuer: input.discovery.issuer,
      subject: payload.sub,
      email:
        typeof payload.email === 'string'
          ? payload.email.trim().toLowerCase()
          : undefined,
      emailVerified: payload.email_verified === true,
      hostedDomain:
        typeof payload.hd === 'string' ? payload.hd.toLowerCase() : undefined,
    };
  }

  authorizationUrl(input: {
    discovery: OidcDiscovery;
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    prompt?: 'login';
  }): string {
    const url = new URL(input.discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', sha256Base64Url(input.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (input.prompt) url.searchParams.set('prompt', input.prompt);
    return url.toString();
  }

  async exchangeCode(input: {
    discovery: OidcDiscovery;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Promise<OidcTokenResponse> {
    const response = await this.fetcher(input.discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code_verifier: input.codeVerifier,
      }),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('OIDC token exchange failed');
    const body = (await response.json()) as { id_token?: unknown };
    if (typeof body.id_token !== 'string' || !body.id_token) {
      throw new Error('OIDC token response is invalid');
    }
    return { idToken: body.id_token };
  }
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
