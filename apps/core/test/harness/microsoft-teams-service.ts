import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import nock from 'nock';

export const teamsTestCredentials = {
  clientId: '44444444-4444-4444-8444-444444444444',
  clientSecret: 'teams-test-secret',
  tenantId: '55555555-5555-4555-8555-555555555555',
};
export const teamsTestPeople = {
  permitted: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyId = 'teams-test-key';

export async function teamsServiceToken(options: {
  serviceUrl: string;
  audience?: string;
  issuer?: string;
  expired?: boolean;
}) {
  return new SignJWT({ serviceurl: options.serviceUrl })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(options.issuer ?? 'https://api.botframework.com')
    .setAudience(options.audience ?? teamsTestCredentials.clientId)
    .setIssuedAt()
    .setExpirationTime(
      options.expired ? Math.floor(Date.now() / 1000) - 600 : '5m',
    )
    .sign(keys.privateKey);
}

/** Fake Microsoft's HTTP endpoints, retaining the real SDK and JWT validation. */
export async function mockMicrosoftTeamsService(input: {
  serviceUrl: string;
  send: (
    conversationId: string,
    message: Record<string, unknown>,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  update?: (
    conversationId: string,
    messageId: string,
    message: Record<string, unknown>,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}) {
  nock.disableNetConnect();
  nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
  const jwk = keys.publicKey.export({ format: 'jwk' });
  nock('https://login.botframework.com')
    .persist()
    .get('/v1/.well-known/keys')
    .reply(200, { keys: [{ ...jwk, kid: keyId, use: 'sig', alg: 'RS256' }] });
  const login = 'https://login.microsoftonline.com';
  const tenant = teamsTestCredentials.tenantId;
  nock(login)
    .persist()
    .get(`/${tenant}/v2.0/.well-known/openid-configuration`)
    .reply(200, {
      issuer: `${login}/${tenant}/v2.0`,
      authorization_endpoint: `${login}/${tenant}/oauth2/v2.0/authorize`,
      token_endpoint: `${login}/${tenant}/oauth2/v2.0/token`,
      jwks_uri: `${login}/${tenant}/discovery/v2.0/keys`,
    });
  const accessToken = await teamsServiceToken({ serviceUrl: input.serviceUrl });
  nock(login)
    .persist()
    .post(`/${tenant}/oauth2/v2.0/token`)
    .query(true)
    .reply(200, {
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: 3600,
      scope: 'https://api.botframework.com/.default',
    });
  const service = new URL(input.serviceUrl);
  const prefix = service.pathname.replace(/\/$/, '') + '/v3/conversations/';
  nock(service.origin)
    .persist()
    .post((path) => path.startsWith(prefix) && path.endsWith('/activities'))
    .matchHeader('authorization', `Bearer ${accessToken}`)
    .reply(async (uri, body) => {
      const conversationId = decodeURIComponent(
        uri.slice(prefix.length, -'/activities'.length),
      );
      const result = await input.send(
        conversationId,
        body as Record<string, unknown>,
      );
      return [result.status, result.body];
    });
  nock(service.origin)
    .persist()
    .put((path) => path.startsWith(prefix) && path.includes('/activities/'))
    .matchHeader('authorization', `Bearer ${accessToken}`)
    .reply(async (uri, body) => {
      const [conversationId, messageId] = uri
        .slice(prefix.length)
        .split('/activities/');
      const result = (await input.update?.(
        decodeURIComponent(conversationId!),
        decodeURIComponent(messageId!),
        body as Record<string, unknown>,
      )) ?? { status: 200, body: { id: 'updated' } };
      return [result.status, result.body];
    });
  return () => {
    nock.cleanAll();
    nock.enableNetConnect();
  };
}
