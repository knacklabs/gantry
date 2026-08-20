import { createHash } from 'node:crypto';

import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

import { matchesAuthToken } from '../../shared/auth-tokens.js';

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported: string[];
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
    if (!isHttpsIssuer(normalizedIssuer)) {
      throw new Error('OIDC discovery is invalid');
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `${normalizedIssuer}/.well-known/openid-configuration`,
      );
    } catch {
      throw new Error('OIDC discovery failed');
    }
    if (!response.ok) throw new Error('OIDC discovery failed');
    let discovery: Partial<OidcDiscovery>;
    try {
      discovery = (await response.json()) as Partial<OidcDiscovery>;
    } catch {
      throw new Error('OIDC discovery is invalid');
    }
    if (
      discovery.issuer !== normalizedIssuer ||
      !isHttpsUrl(discovery.authorization_endpoint) ||
      !isHttpsUrl(discovery.token_endpoint) ||
      !isHttpsUrl(discovery.jwks_uri) ||
      !Array.isArray(discovery.id_token_signing_alg_values_supported) ||
      discovery.id_token_signing_alg_values_supported.length === 0 ||
      discovery.id_token_signing_alg_values_supported.some(
        (algorithm) => typeof algorithm !== 'string' || !algorithm,
      )
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
    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
    try {
      ({ payload } = await jwtVerify(input.token, jwks, {
        issuer: input.discovery.issuer,
        audience: input.clientId,
        algorithms: input.discovery.id_token_signing_alg_values_supported,
        requiredClaims: ['exp'],
      }));
    } catch {
      throw new Error('OIDC token validation failed');
    }
    const hasInvalidAuthorizedParty =
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        typeof payload.azp !== 'string') ||
      (payload.azp !== undefined && payload.azp !== input.clientId);
    if (
      hasInvalidAuthorizedParty ||
      typeof payload.nonce !== 'string' ||
      !matchesAuthToken(payload.nonce, input.nonceHash) ||
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
    let response: Response;
    try {
      response = await this.fetcher(input.discovery.token_endpoint, {
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
    } catch {
      throw new Error('OIDC token exchange failed');
    }
    if (!response.ok) throw new Error('OIDC token exchange failed');
    let body: { id_token?: unknown };
    try {
      body = (await response.json()) as { id_token?: unknown };
    } catch {
      throw new Error('OIDC token response is invalid');
    }
    if (typeof body.id_token !== 'string' || !body.id_token) {
      throw new Error('OIDC token response is invalid');
    }
    return { idToken: body.id_token };
  }
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isHttpsIssuer(value: unknown): value is string {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value);
  return !url.search && !url.hash;
}
