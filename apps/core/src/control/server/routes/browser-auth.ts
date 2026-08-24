import { lookup } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ACCESS_REFERENCE_TTL_MS,
  LOCAL_AUTHORIZATION_TTL_MS,
  createAccessReference,
  createOpaqueToken,
  expiresAt,
  hashAuthToken,
  isRecentlyReauthenticated,
} from '../../../application/auth/auth-foundations.js';
import { OidcAdapter } from '../../../adapters/auth/oidc-adapter.js';
import { createRepositoryRuntimeSecretProvider } from '../../../adapters/credentials/repository-runtime-secret-provider.js';
import { PostgresAuthenticationRepository } from '../../../adapters/storage/postgres/repositories/authentication-repository.postgres.js';
import { PostgresRuntimeEventRepository } from '../../../adapters/storage/postgres/repositories/runtime-event-repository.postgres.js';
import { decryptCredentialSecretValue } from '../../../adapters/storage/postgres/repositories/credential-secret-crypto.js';
import { PostgresPersonIdentityRepository } from '../../../adapters/storage/postgres/repositories/person-identity-repository.postgres.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { getOptionalRuntimeSecret } from '../../../domain/ports/runtime-secret-provider.js';
import type { AppId } from '../../../domain/app/app.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../../../domain/events/runtime-event-types.js';
import { createDnsPinnedMcpFetch } from '../../../shared/dns-pinned-fetch.js';
import { nowIso } from '../../../shared/time/datetime.js';
import { getRuntimeSettingsForConfig } from '../../../config/index.js';
import { writeBrowserAuthenticationSettings } from '../../../config/settings/browser-auth-settings.js';
import {
  browserSessionCookie,
  browserCsrfCookie,
  browserSessionToken,
  csrfMatches,
  isCanonicalBrowserOrigin,
  isLoopbackHost,
} from '../browser-auth-boundary.js';
import type { ControlRouteContext } from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  beginOidcSignIn,
  oidcRedirectUri,
  oidcStateMatches,
  parseOidcConfiguration,
  parseTransactionOidcConfig,
} from '../browser-oidc.js';

const APP_ID = 'default';
const LOCAL_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const LOCAL_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const HOSTED_IDLE_MS = 2 * 60 * 60 * 1000;
const HOSTED_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const AUTH_RATE_LIMIT_PER_MINUTE = 20;
type AuthMode = 'local' | 'hosted';

function repository(): PostgresAuthenticationRepository {
  return new PostgresAuthenticationRepository(getRuntimeStorage().service.db);
}

async function recordAuthEvent(input: {
  appId: string;
  eventType: RuntimeEventType;
  actor: string;
  payload: Record<string, string>;
}): Promise<void> {
  await new PostgresRuntimeEventRepository(
    getRuntimeStorage().service.db,
  ).appendRuntimeEvent({
    appId: input.appId as AppId,
    eventType: input.eventType,
    actor: input.actor,
    payload: input.payload,
  });
}

function runtimeSecrets() {
  const storage = getRuntimeStorage();
  return createRepositoryRuntimeSecretProvider({
    appId: APP_ID as never,
    repository: storage.repositories.capabilitySecrets,
  });
}

function oidcAdapter(): OidcAdapter {
  return new OidcAdapter(
    createDnsPinnedMcpFetch({
      lookupHostname: async (hostname) =>
        (await lookup(hostname, { all: true })).flatMap((record) =>
          record.family === 4 || record.family === 6
            ? [{ address: record.address, family: record.family }]
            : [],
        ),
    }),
  );
}

function canonicalHost(canonicalOrigin: string): string {
  return new URL(canonicalOrigin).host.toLowerCase();
}

function localHostIsValid(req: IncomingMessage, origin: string): boolean {
  const expected = canonicalHost(origin);
  return (
    req.headers.host?.toLowerCase() === expected &&
    isLoopbackHost(expected) &&
    isLoopbackHost(req.headers.host)
  );
}

function sessionLifetimes(mode: 'local' | 'hosted', now: Date) {
  return {
    idleExpiresAt: expiresAt(
      now,
      mode === 'local' ? LOCAL_IDLE_MS : HOSTED_IDLE_MS,
    ).toISOString(),
    absoluteExpiresAt: expiresAt(
      now,
      mode === 'local' ? LOCAL_ABSOLUTE_MS : HOSTED_ABSOLUTE_MS,
    ).toISOString(),
  };
}

export async function activeSession(req: IncomingMessage, mode: AuthMode) {
  const token = browserSessionToken(req, mode);
  if (!token) return null;
  const now = new Date();
  return repository().getActiveSession({
    sessionHash: hashAuthToken(token),
    now: now.toISOString(),
    nextIdleExpiresAt: sessionLifetimes(mode, now).idleExpiresAt,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function consumeAuthRateLimit(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
): boolean {
  const key = `browser-auth:${req.socket.remoteAddress ?? 'unknown'}`;
  if (ctx.triggerRateLimiter.consume(key, AUTH_RATE_LIMIT_PER_MINUTE)) {
    return true;
  }
  sendError(res, 429, 'RATE_LIMITED', 'Try again later.');
  return false;
}

export async function requireBrowserMutationSession(input: {
  req: IncomingMessage;
  res: ServerResponse;
  mode: 'local' | 'hosted';
  originIsValid: boolean;
}) {
  const session = await activeSession(input.req, input.mode);
  const csrf = Array.isArray(input.req.headers['x-csrf-token'])
    ? undefined
    : input.req.headers['x-csrf-token'];
  if (
    !session ||
    !input.originIsValid ||
    !csrfMatches(csrf, session.csrfHash)
  ) {
    sendError(input.res, 403, 'FORBIDDEN', 'Request could not be authorized.');
    return null;
  }
  return session;
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

function oidcFlowDependencies() {
  return {
    adapter: oidcAdapter(),
    repository: repository(),
    secrets: runtimeSecrets(),
  };
}

async function issueSession(input: {
  res: ServerResponse;
  mode: 'local' | 'hosted';
  canonicalOrigin: string;
  appId: string;
  userId: string;
  reauthenticatedAt?: string;
}): Promise<void> {
  const now = new Date();
  const sessionToken = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  await repository().createBrowserSession({
    appId: input.appId,
    userId: input.userId,
    sessionHash: hashAuthToken(sessionToken),
    csrfHash: hashAuthToken(csrfToken),
    ...sessionLifetimes(input.mode, now),
    reauthenticatedAt: input.reauthenticatedAt ?? now.toISOString(),
    now: now.toISOString(),
  });
  const secure = new URL(input.canonicalOrigin).protocol === 'https:';
  input.res.setHeader('Set-Cookie', [
    browserSessionCookie(input.mode, sessionToken, secure),
    browserCsrfCookie(input.mode, csrfToken, secure),
  ]);
}

export async function handleBrowserAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/auth/') && !pathname.startsWith('/ui/api/auth/')) {
    return false;
  }

  const authentication = getRuntimeSettingsForConfig().authentication;
  const mode = authentication.mode;
  const originIsValid = isCanonicalBrowserOrigin(
    req,
    authentication.canonicalOrigin,
  );

  if (pathname === '/auth/local/authorize') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    if (mode !== 'local') {
      sendError(res, 404, 'NOT_FOUND', 'Route not found');
      return true;
    }
    if (!consumeAuthRateLimit(req, res, ctx)) return true;
    if (
      !originIsValid ||
      !localHostIsValid(req, authentication.canonicalOrigin)
    ) {
      sendError(
        res,
        403,
        'LOCAL_AUTHORIZATION_HOST_INVALID',
        'This authorization link can only be used on this Gantry host.',
      );
      return true;
    }
    const body = await readJson(req);
    if (!isObject(body) || typeof body.token !== 'string' || !body.token) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid authorization request.');
      return true;
    }
    const now = new Date();
    const tokenHash = hashAuthToken(body.token);
    const code = await repository().consumeLocalAuthorizationCode(
      tokenHash,
      canonicalHost(authentication.canonicalOrigin),
      now.toISOString(),
    );
    if (!code) {
      const status = await repository().localAuthorizationCodeStatus(
        tokenHash,
        canonicalHost(authentication.canonicalOrigin),
        now.toISOString(),
      );
      await recordAuthEvent({
        appId: APP_ID,
        eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
        actor: 'auth:local',
        payload: { classification: status },
      });
      sendError(
        res,
        400,
        status === 'wrong_host'
          ? 'LOCAL_AUTHORIZATION_WRONG_HOST'
          : status === 'used'
            ? 'LOCAL_AUTHORIZATION_USED'
            : 'LOCAL_AUTHORIZATION_EXPIRED',
        status === 'wrong_host'
          ? 'This authorization link can only be used on this Gantry host.'
          : status === 'used'
            ? 'This authorization link has already been used.'
            : 'This authorization link has expired. Run `gantry ui authorize` to create a new one.',
      );
      return true;
    }
    if (!code.userId) {
      await recordAuthEvent({
        appId: code.appId,
        eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
        actor: 'auth:local',
        payload: { classification: 'invalid_code' },
      });
      sendError(
        res,
        400,
        'LOCAL_AUTHORIZATION_INVALID',
        'Invalid authorization request.',
      );
      return true;
    }
    await issueSession({
      res,
      mode: 'local',
      canonicalOrigin: authentication.canonicalOrigin,
      appId: code.appId,
      userId: code.userId,
      reauthenticatedAt: now.toISOString(),
    });
    await recordAuthEvent({
      appId: code.appId,
      eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_SUCCEEDED,
      actor: 'auth:local',
      payload: { mode: 'local', userId: code.userId },
    });
    sendJson(res, 200, { message: 'This browser is authorized.' });
    return true;
  }
  if (pathname === '/auth/oidc/start') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    if (mode !== 'hosted' || !authentication.activeOidc) {
      redirect(
        res,
        new URL(
          '/ui/auth/callback-failed',
          authentication.canonicalOrigin,
        ).toString(),
      );
      return true;
    }
    if (!consumeAuthRateLimit(req, res, ctx)) return true;
    try {
      redirect(
        res,
        await beginOidcSignIn({
          ...oidcFlowDependencies(),
          appId: APP_ID,
          canonicalOrigin: authentication.canonicalOrigin,
          oidc: authentication.activeOidc,
          response: res,
        }),
      );
    } catch {
      redirect(
        res,
        new URL(
          '/ui/auth/callback-failed',
          authentication.canonicalOrigin,
        ).toString(),
      );
    }
    return true;
  }
  if (pathname === '/auth/invitations/start') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    if (mode !== 'hosted' || !authentication.activeOidc || !originIsValid) {
      sendError(res, 403, 'FORBIDDEN', 'Request could not be authorized.');
      return true;
    }
    if (!consumeAuthRateLimit(req, res, ctx)) return true;
    const body = await readJson(req);
    if (!isObject(body) || typeof body.token !== 'string' || !body.token) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid invitation request.');
      return true;
    }
    const invitationTokenHash = hashAuthToken(body.token);
    const status = await repository().invitationStatus(
      invitationTokenHash,
      nowIso(),
    );
    if (status.status !== 'valid') {
      sendError(
        res,
        400,
        `INVITATION_${status.status.toUpperCase()}`,
        status.status === 'used'
          ? 'This invitation has already been used.'
          : 'This invitation has expired. Ask an administrator for a new one.',
      );
      return true;
    }
    try {
      sendJson(res, 200, {
        redirectUrl: await beginOidcSignIn({
          ...oidcFlowDependencies(),
          appId: APP_ID,
          canonicalOrigin: authentication.canonicalOrigin,
          oidc: authentication.activeOidc,
          invitationTokenHash,
          response: res,
        }),
      });
    } catch {
      sendError(
        res,
        400,
        'OIDC_START_FAILED',
        'Sign-in could not be completed. Start again from Gantry.',
      );
    }
    return true;
  }

  if (pathname === '/auth/oidc/reauth') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await activeSession(req, mode);
    const sessionToken = browserSessionToken(req, 'hosted');
    if (
      mode !== 'hosted' ||
      !authentication.activeOidc ||
      !session ||
      !sessionToken
    ) {
      redirect(
        res,
        new URL('/ui/auth/sign-in', authentication.canonicalOrigin).toString(),
      );
      return true;
    }
    try {
      redirect(
        res,
        await beginOidcSignIn({
          ...oidcFlowDependencies(),
          appId: APP_ID,
          canonicalOrigin: authentication.canonicalOrigin,
          oidc: authentication.activeOidc,
          reauthenticateUserId: session.userId,
          reauthenticateSessionHash: hashAuthToken(sessionToken),
          prompt: 'login',
          response: res,
        }),
      );
    } catch {
      redirect(
        res,
        new URL(
          '/ui/auth/callback-failed',
          authentication.canonicalOrigin,
        ).toString(),
      );
    }
    return true;
  }

  if (pathname === '/auth/oidc/callback') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const callback = new URL(req.url || '/', authentication.canonicalOrigin);
    const state = callback.searchParams.get('state');
    const code = callback.searchParams.get('code');
    if (
      !code ||
      !state ||
      !oidcStateMatches(
        req.headers.cookie,
        authentication.canonicalOrigin,
        state,
      )
    ) {
      redirect(
        res,
        new URL(
          '/ui/auth/callback-failed',
          authentication.canonicalOrigin,
        ).toString(),
      );
      return true;
    }
    let configurationTest = false;
    try {
      const transaction = await repository().consumeOidcTransaction(
        hashAuthToken(state),
        nowIso(),
      );
      if (!transaction) throw new Error('OIDC transaction is invalid');
      configurationTest = transaction.configurationTest;
      const oidc = configurationTest
        ? parseTransactionOidcConfig(transaction.oidcConfigJson)
        : authentication.activeOidc;
      if (!oidc)
        throw new Error('OIDC transaction configuration is unavailable');
      const secrets = runtimeSecrets();
      const verifier = decryptCredentialSecretValue(
        transaction.encryptedPkceVerifier,
        {
          appId: transaction.appId,
          subjectKind: 'oidc_transaction',
          subjectId: transaction.id,
          schemaVersion: 1,
        },
        secrets,
      );
      const clientSecret = await getOptionalRuntimeSecret(secrets, {
        ref: oidc.clientSecretRef,
      });
      if (!clientSecret) throw new Error('OIDC secret is unavailable');
      const adapter = oidcAdapter();
      const discovery = await adapter.discover(oidc.issuer);
      const tokens = await adapter.exchangeCode({
        discovery,
        clientId: oidc.clientId,
        clientSecret,
        redirectUri: oidcRedirectUri(authentication.canonicalOrigin),
        code,
        codeVerifier: verifier,
      });
      const identity = await adapter.validateIdToken({
        token: tokens.idToken,
        discovery,
        clientId: oidc.clientId,
        nonceHash: transaction.nonceHash,
      });
      if (configurationTest) {
        const target = new URL(
          '/ui/settings/authentication-access',
          authentication.canonicalOrigin,
        );
        target.searchParams.set('configuration-tested', '1');
        redirect(res, target.toString());
        return true;
      }
      const person = await new PostgresPersonIdentityRepository(
        getRuntimeStorage().service.db,
      ).attestOidcIdentity({
        appId: transaction.appId,
        issuer: identity.issuer,
        subject: identity.subject,
        verifiedEmail: identity.emailVerified ? identity.email : undefined,
      });
      if (!person.personId) throw new Error('OIDC identity attestation failed');
      const repo = repository();
      if (
        transaction.reauthenticateUserId ||
        transaction.reauthenticateSessionHash
      ) {
        const now = new Date();
        const reauthenticationSession =
          transaction.reauthenticateUserId &&
          transaction.reauthenticateSessionHash
            ? await repo.getActiveSession({
                sessionHash: transaction.reauthenticateSessionHash,
                now: now.toISOString(),
                nextIdleExpiresAt: sessionLifetimes('hosted', now)
                  .idleExpiresAt,
              })
            : null;
        if (
          !reauthenticationSession ||
          reauthenticationSession.appId !== transaction.appId ||
          reauthenticationSession.userId !== person.personId ||
          transaction.reauthenticateUserId !== person.personId
        ) {
          throw new Error('OIDC reauthentication session is invalid');
        }
      }
      if (transaction.invitationTokenHash) {
        if (!identity.emailVerified || !identity.email) {
          await recordAuthEvent({
            appId: transaction.appId,
            eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
            actor: 'auth:oidc',
            payload: { classification: 'invitation_email_unverified' },
          });
          redirect(
            res,
            new URL(
              '/ui/auth/no-access',
              authentication.canonicalOrigin,
            ).toString(),
          );
          return true;
        }
        const accepted = await repo.acceptInvitation({
          tokenHash: transaction.invitationTokenHash,
          userId: person.personId,
          verifiedEmail: identity.email,
          now: nowIso(),
        });
        if (accepted.status === 'mismatch') {
          await recordAuthEvent({
            appId: transaction.appId,
            eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
            actor: 'auth:oidc',
            payload: { classification: 'invitation_email_mismatch' },
          });
          const target = new URL(
            '/ui/auth/no-access',
            authentication.canonicalOrigin,
          );
          target.searchParams.set('reason', 'invitation-email-mismatch');
          redirect(res, target.toString());
          return true;
        }
        if (accepted.status !== 'accepted') {
          await recordAuthEvent({
            appId: transaction.appId,
            eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
            actor: 'auth:oidc',
            payload: { classification: `invitation_${accepted.status}` },
          });
          const target = new URL(
            '/ui/auth/no-access',
            authentication.canonicalOrigin,
          );
          target.searchParams.set('reason', `invitation-${accepted.status}`);
          redirect(res, target.toString());
          return true;
        }
        await recordAuthEvent({
          appId: transaction.appId,
          eventType: RUNTIME_EVENT_TYPES.AUTH_INVITATION_ACCEPTED,
          actor: 'auth:oidc',
          payload: { role: accepted.role },
        });
      }
      let grant = await repo.getGrant(transaction.appId, person.personId);
      if (!grant && identity.hostedDomain === oidc.companyDomain) {
        await repo.createDomainViewerGrant({
          appId: transaction.appId,
          userId: person.personId,
          now: nowIso(),
        });
        grant = await repo.getGrant(transaction.appId, person.personId);
      }
      if (!grant || grant.status === 'awaiting_approval') {
        const reference = createAccessReference();
        const now = nowIso();
        const accessReferenceExpiresAt = expiresAt(
          new Date(),
          ACCESS_REFERENCE_TTL_MS,
        ).toISOString();
        const accessReferenceHash = hashAuthToken(reference);
        const awaitingGrant = grant
          ? await repo.refreshAwaitingGrant({
              appId: transaction.appId,
              userId: person.personId,
              accessReferenceHash,
              accessReferenceExpiresAt,
              now,
            })
          : await repo.createAwaitingGrant({
              appId: transaction.appId,
              userId: person.personId,
              accessReferenceHash,
              accessReferenceExpiresAt,
              now,
            });
        if (awaitingGrant) {
          const target = new URL(
            '/ui/auth/no-access',
            authentication.canonicalOrigin,
          );
          target.searchParams.set('reference', reference);
          await recordAuthEvent({
            appId: transaction.appId,
            eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
            actor: 'auth:oidc',
            payload: { classification: 'awaiting_approval' },
          });
          redirect(res, target.toString());
          return true;
        }
        grant = await repo.getGrant(transaction.appId, person.personId);
      }
      if (!grant) throw new Error('Console access grant is unavailable');
      if (grant.status === 'disabled') {
        await recordAuthEvent({
          appId: transaction.appId,
          eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
          actor: 'auth:oidc',
          payload: { classification: 'access_disabled' },
        });
        redirect(
          res,
          new URL(
            '/ui/auth/disabled',
            authentication.canonicalOrigin,
          ).toString(),
        );
        return true;
      }
      if (grant.status !== 'active') {
        await recordAuthEvent({
          appId: transaction.appId,
          eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
          actor: 'auth:oidc',
          payload: { classification: 'access_awaiting_approval' },
        });
        redirect(
          res,
          new URL(
            '/ui/auth/no-access',
            authentication.canonicalOrigin,
          ).toString(),
        );
        return true;
      }
      const previous = browserSessionToken(req, 'hosted');
      if (transaction.reauthenticateSessionHash) {
        await repo.revokeSession(
          transaction.reauthenticateSessionHash,
          nowIso(),
        );
      } else if (previous) {
        await repo.revokeSession(hashAuthToken(previous), nowIso());
      }
      await issueSession({
        res,
        mode: 'hosted',
        canonicalOrigin: authentication.canonicalOrigin,
        appId: transaction.appId,
        userId: person.personId,
      });
      await recordAuthEvent({
        appId: transaction.appId,
        eventType: transaction.reauthenticateUserId
          ? RUNTIME_EVENT_TYPES.AUTH_REAUTHENTICATED
          : RUNTIME_EVENT_TYPES.AUTH_LOGIN_SUCCEEDED,
        actor: 'auth:oidc',
        payload: {
          mode: 'hosted',
          role: grant.role,
          userId: person.personId,
        },
      });
      redirect(
        res,
        new URL(
          transaction.reauthenticateUserId ? '/ui?reauthenticated=1' : '/ui',
          authentication.canonicalOrigin,
        ).toString(),
      );
    } catch {
      await recordAuthEvent({
        appId: APP_ID,
        eventType: RUNTIME_EVENT_TYPES.AUTH_LOGIN_FAILED,
        actor: 'auth:oidc',
        payload: {
          classification: configurationTest
            ? 'configuration_test_failed'
            : 'callback_failed',
        },
      });
      if (configurationTest) {
        const target = new URL(
          '/ui/settings/authentication-access',
          authentication.canonicalOrigin,
        );
        target.searchParams.set('configuration-test-failed', '1');
        redirect(res, target.toString());
        return true;
      }
      redirect(
        res,
        new URL(
          '/ui/auth/callback-failed',
          authentication.canonicalOrigin,
        ).toString(),
      );
    }
    return true;
  }

  if (pathname === '/ui/api/auth/local/authorize') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await requireBrowserMutationSession({
      req,
      res,
      mode,
      originIsValid,
    });
    if (mode !== 'local' || !session) return true;
    sendJson(res, 200, {
      authorizationUrl: await createLocalAuthorizationUrl({
        canonicalOrigin: authentication.canonicalOrigin,
      }),
    });
    return true;
  }

  if (pathname === '/ui/api/auth/config') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await activeSession(req, mode);
    if (!session || session.role !== 'administrator') {
      sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
      return true;
    }
    sendJson(res, 200, {
      mode,
      canonicalOrigin: authentication.canonicalOrigin,
      providerLabel: authentication.activeOidc?.providerLabel,
      candidateConfigured: Boolean(authentication.candidateOidc),
    });
    return true;
  }

  if (pathname === '/ui/api/auth/config/candidate') {
    if (req.method !== 'PUT') {
      res.setHeader('Allow', 'PUT');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await requireBrowserMutationSession({
      req,
      res,
      mode,
      originIsValid,
    });
    if (!session || session.role !== 'administrator') {
      if (session)
        sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
      return true;
    }
    if (
      mode === 'hosted' &&
      !isRecentlyReauthenticated(session.reauthenticatedAt)
    ) {
      sendError(
        res,
        401,
        'REAUTHENTICATION_REQUIRED',
        'Sign in again to continue.',
      );
      return true;
    }
    const candidate = parseOidcConfiguration(await readJson(req));
    if (!candidate) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Complete every sign-in configuration field.',
      );
      return true;
    }
    try {
      const current = getRuntimeSettingsForConfig();
      await writeBrowserAuthenticationSettings({
        previousSettings: current,
        settings: {
          ...current,
          authentication: {
            ...current.authentication,
            candidateOidc: candidate,
          },
        },
        userId: session.userId,
      });
      sendJson(res, 200, {
        message: 'Sign-in configuration saved. Test it before activation.',
      });
    } catch {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Sign-in configuration could not be saved.',
      );
    }
    return true;
  }

  if (pathname === '/ui/api/auth/invitations') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    if (req.method === 'GET') {
      const session = await activeSession(req, mode);
      if (!session || session.role !== 'administrator') {
        sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
        return true;
      }
      sendJson(res, 200, {
        invitations: await repository().listInvitations(session.appId),
      });
      return true;
    }
    const session = await requireBrowserMutationSession({
      req,
      res,
      mode,
      originIsValid,
    });
    if (!session || session.role !== 'administrator') {
      if (session)
        sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
      return true;
    }
    const body = await readJson(req);
    const email =
      isObject(body) && typeof body.email === 'string'
        ? body.email.trim().toLowerCase()
        : '';
    const role =
      isObject(body) &&
      (body.role === 'administrator' || body.role === 'viewer')
        ? body.role
        : 'viewer';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'A valid email address is required.',
      );
      return true;
    }
    if (
      role === 'administrator' &&
      mode === 'hosted' &&
      !isRecentlyReauthenticated(session.reauthenticatedAt)
    ) {
      sendError(
        res,
        401,
        'REAUTHENTICATION_REQUIRED',
        'Sign in again to continue.',
      );
      return true;
    }
    const token = createOpaqueToken();
    const now = new Date();
    await repository().createInvitation({
      appId: session.appId,
      tokenHash: hashAuthToken(token),
      invitedEmail: email,
      role,
      expiresAt: expiresAt(now, 7 * 24 * 60 * 60 * 1000).toISOString(),
      now: now.toISOString(),
    });
    await recordAuthEvent({
      appId: session.appId,
      eventType: RUNTIME_EVENT_TYPES.AUTH_INVITATION_CREATED,
      actor: `browser:${session.userId}`,
      payload: { role },
    });
    const invitationUrl = new URL(
      '/ui/auth/invitation',
      authentication.canonicalOrigin,
    );
    invitationUrl.hash = `token=${token}`;
    sendJson(res, 201, {
      message:
        'Invitation created. This link can be used once and expires in 7 days.',
      invitationUrl: invitationUrl.toString(),
    });
    return true;
  }

  const invitationMatch = pathname.match(
    /^\/ui\/api\/auth\/invitations\/([^/]+)$/,
  );
  if (invitationMatch) {
    if (req.method !== 'DELETE') {
      res.setHeader('Allow', 'DELETE');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await requireBrowserMutationSession({
      req,
      res,
      mode,
      originIsValid,
    });
    if (!session || session.role !== 'administrator') {
      if (session)
        sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
      return true;
    }
    const revoked = await repository().revokeInvitationById({
      id: invitationMatch[1],
      appId: session.appId,
      actor: `browser:${session.userId}`,
      now: nowIso(),
    });
    if (!revoked) {
      sendError(res, 404, 'NOT_FOUND', 'Invitation is no longer available.');
      return true;
    }
    await recordAuthEvent({
      appId: session.appId,
      eventType: RUNTIME_EVENT_TYPES.AUTH_INVITATION_REVOKED,
      actor: `browser:${session.userId}`,
      payload: {},
    });
    sendJson(res, 200, { message: 'Invitation revoked.' });
    return true;
  }

  if (
    pathname === '/ui/api/auth/config/test' ||
    pathname === '/ui/api/auth/config/activate'
  ) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await requireBrowserMutationSession({
      req,
      res,
      mode,
      originIsValid,
    });
    if (!session || session.role !== 'administrator') {
      if (session)
        sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
      return true;
    }
    const candidate = authentication.candidateOidc;
    if (!candidate) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'No candidate sign-in configuration is available.',
      );
      return true;
    }
    if (pathname.endsWith('/test')) {
      try {
        const secret = await getOptionalRuntimeSecret(runtimeSecrets(), {
          ref: candidate.clientSecretRef,
        });
        if (!secret) throw new Error('OIDC client secret is unavailable');
        sendJson(res, 200, {
          redirectUrl: await beginOidcSignIn({
            ...oidcFlowDependencies(),
            appId: APP_ID,
            canonicalOrigin: authentication.canonicalOrigin,
            oidc: candidate,
            configurationTest: true,
            response: res,
          }),
        });
      } catch {
        sendError(
          res,
          400,
          'OIDC_CONFIGURATION_INVALID',
          'Sign-in configuration could not be verified. The active configuration was not changed.',
        );
      }
      return true;
    }
    if (
      mode === 'hosted' &&
      !isRecentlyReauthenticated(session.reauthenticatedAt)
    ) {
      sendError(
        res,
        401,
        'REAUTHENTICATION_REQUIRED',
        'Sign in again to continue.',
      );
      return true;
    }
    await writeBrowserAuthenticationSettings({
      previousSettings: getRuntimeSettingsForConfig(),
      settings: {
        ...getRuntimeSettingsForConfig(),
        authentication: {
          ...authentication,
          mode: 'hosted',
          activeOidc: candidate,
          candidateOidc: undefined,
        },
      },
      userId: session.userId,
    });
    await recordAuthEvent({
      appId: session.appId,
      eventType: RUNTIME_EVENT_TYPES.AUTH_CONFIGURATION_ACTIVATED,
      actor: `browser:${session.userId}`,
      payload: { provider: candidate.providerLabel },
    });
    sendJson(res, 200, { message: 'Configuration activated.' });
    return true;
  }

  if (pathname === '/ui/api/auth/access') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await activeSession(req, mode);
    if (!session || session.role !== 'administrator') {
      sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
      return true;
    }
    sendJson(res, 200, {
      grants: await repository().listAccessGrants(session.appId),
    });
    return true;
  }

  const accessMatch = pathname.match(/^\/ui\/api\/auth\/access\/([^/]+)$/);
  if (accessMatch) {
    if (req.method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await requireBrowserMutationSession({
      req,
      res,
      mode,
      originIsValid,
    });
    if (!session || session.role !== 'administrator') {
      if (session)
        sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
      return true;
    }
    const body = await readJson(req);
    const role =
      isObject(body) &&
      (body.role === 'administrator' || body.role === 'viewer')
        ? body.role
        : undefined;
    const status =
      isObject(body) && (body.status === 'active' || body.status === 'disabled')
        ? body.status
        : undefined;
    if (!role && !status) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'A role or status change is required.',
      );
      return true;
    }
    if (
      (role === 'administrator' || status === 'active') &&
      mode === 'hosted' &&
      !isRecentlyReauthenticated(session.reauthenticatedAt)
    ) {
      sendError(
        res,
        401,
        'REAUTHENTICATION_REQUIRED',
        'Sign in again to continue.',
      );
      return true;
    }
    const updated = await repository().updateGrant(
      session.appId,
      accessMatch[1],
      { ...(role ? { role } : {}), ...(status ? { status } : {}) },
      nowIso(),
    );
    if (!updated) {
      sendError(
        res,
        409,
        'FINAL_ADMINISTRATOR',
        'At least one active Administrator is required.',
      );
      return true;
    }
    await recordAuthEvent({
      appId: session.appId,
      eventType: RUNTIME_EVENT_TYPES.AUTH_ACCESS_CHANGED,
      actor: `browser:${session.userId}`,
      payload: {
        ...(role ? { role } : {}),
        ...(status ? { status } : {}),
      },
    });
    sendJson(res, 200, {
      message:
        status === 'disabled'
          ? 'Console access disabled.'
          : status === 'active'
            ? 'Console access restored.'
            : role === 'administrator'
              ? 'Administrator access granted.'
              : 'Viewer access granted.',
    });
    return true;
  }

  if (pathname === '/ui/api/auth/sessions') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await activeSession(req, mode);
    if (!session) {
      sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
      return true;
    }
    sendJson(res, 200, {
      currentSessionId: session.id,
      sessions: await repository().listBrowserSessions(
        session.appId,
        session.userId,
      ),
    });
    return true;
  }

  const sessionMatch = pathname.match(
    /^\/ui\/api\/auth\/sessions\/([^/]+)\/revoke$/,
  );
  if (sessionMatch) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await requireBrowserMutationSession({
      req,
      res,
      mode,
      originIsValid,
    });
    if (!session) return true;
    const revoked = await repository().revokeSessionById({
      id: sessionMatch[1],
      appId: session.appId,
      userId: session.userId,
      now: nowIso(),
    });
    if (revoked)
      await recordAuthEvent({
        appId: session.appId,
        eventType: RUNTIME_EVENT_TYPES.AUTH_SESSION_REVOKED,
        actor: `browser:${session.userId}`,
        payload: { scope: 'self' },
      });
    sendJson(res, 200, { message: 'Browser session revoked.' });
    return true;
  }

  if (pathname === '/ui/api/auth/session') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const session = await activeSession(req, mode);
    if (!session) {
      sendJson(res, 401, { mode });
      return true;
    }
    sendJson(res, 200, {
      mode,
      principal: {
        role: session.role,
        displayName: session.displayName,
      },
      absoluteExpiresAt: session.absoluteExpiresAt,
    });
    return true;
  }

  if (pathname === '/ui/api/auth/events') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    if (!req.headers.accept?.includes('text/event-stream')) {
      sendError(res, 406, 'NOT_ACCEPTABLE', 'Event stream is required.');
      return true;
    }
    if (ctx.state.activeStreams >= ctx.maxConcurrentStreams) {
      sendError(res, 429, 'TOO_MANY_STREAMS', 'Too many active event streams');
      return true;
    }
    if (!(await activeSession(req, mode))) {
      sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
      return true;
    }
    ctx.state.activeStreams += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('connection', 'keep-alive');
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      ctx.state.activeStreams = Math.max(0, ctx.state.activeStreams - 1);
      if (!res.writableEnded) res.end();
    };
    req.once('close', close);
    res.once('close', close);
    const revalidate = async () => {
      if (closed) return;
      if (!(await activeSession(req, mode))) {
        res.write('event: access-revoked\ndata: {}\n\n');
        close();
        return;
      }
      res.write(': heartbeat\n\n');
    };
    await revalidate();
    if (!closed)
      heartbeat = setInterval(() => void revalidate().catch(close), 30_000);
    return true;
  }
  if (pathname === '/auth/logout') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const sessionToken = browserSessionToken(req, mode);
    const session = await activeSession(req, mode);
    if (
      !sessionToken ||
      !session ||
      !originIsValid ||
      !csrfMatches(
        Array.isArray(req.headers['x-csrf-token'])
          ? undefined
          : req.headers['x-csrf-token'],
        session.csrfHash,
      )
    ) {
      sendError(res, 403, 'FORBIDDEN', 'Request could not be authorized.');
      return true;
    }
    await repository().revokeSession(hashAuthToken(sessionToken), nowIso());
    await recordAuthEvent({
      appId: session.appId,
      eventType: RUNTIME_EVENT_TYPES.AUTH_LOGOUT,
      actor: `browser:${session.userId}`,
      payload: { mode },
    });
    const hosted = mode === 'hosted';
    res.setHeader('Set-Cookie', [
      `${hosted ? '__Host-gantry-session' : 'gantry_session'}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${hosted ? '; Secure' : ''}`,
      `${hosted ? '__Host-gantry-csrf' : 'gantry_csrf'}=; SameSite=Strict; Path=/; Max-Age=0${hosted ? '; Secure' : ''}`,
    ]);
    sendJson(res, 200, { message: 'Signed out.' });
    return true;
  }

  return false;
}

export async function createLocalAuthorizationUrl(input: {
  canonicalOrigin: string;
}): Promise<string> {
  const now = new Date();
  const token = createOpaqueToken();
  const repo = repository();
  const userId = await repo.ensureLocalAdministrator(APP_ID, now.toISOString());
  await repo.createLocalAuthorizationCode({
    appId: APP_ID,
    userId,
    tokenHash: hashAuthToken(token),
    canonicalHost: canonicalHost(input.canonicalOrigin),
    expiresAt: expiresAt(now, LOCAL_AUTHORIZATION_TTL_MS).toISOString(),
    now: now.toISOString(),
  });
  const url = new URL('/ui/auth/local', input.canonicalOrigin);
  url.hash = `token=${token}`;
  return url.toString();
}
