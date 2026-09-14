import type { IncomingMessage, ServerResponse } from 'node:http';

import { isCredentialSecretCryptoError } from '../../../adapters/storage/postgres/repositories/credential-secret-crypto.js';
import { ModelCredentialService } from '../../../application/model-credentials/model-credential-service.js';
import {
  requiredModelCredentialProviderUsage,
  type RequiredModelCredentialProvidersSettings,
} from '../../../application/model-resolution/required-model-credential-providers.js';
import { isRecentlyReauthenticated } from '../../../application/auth/auth-foundations.js';
import {
  preflightModelProvider,
  type ModelProviderPreflightSettings,
} from '../../../adapters/llm/model-provider-preflight.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import {
  isAgentHarness,
  type AgentHarness,
} from '../../../shared/agent-engine.js';
import { resolveModelSelectionForWorkload } from '../../../shared/model-catalog.js';
import { resolveExecutionRoute } from '../../../shared/model-execution-route.js';
import {
  listSupportedModelCredentialProviders,
  normalizeModelCredentialProvider,
} from '../../../domain/model-credentials/model-credentials.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';

type BrowserModelProviderSettings = RequiredModelCredentialProvidersSettings &
  ModelProviderPreflightSettings & {
    authentication: {
      mode: 'local' | 'hosted';
      canonicalOrigin: string;
    };
  };

function modelCredentialService(): ModelCredentialService {
  const storage = getRuntimeStorage();
  return new ModelCredentialService(
    storage.repositories.modelCredentials,
    (event) => storage.runtimeEvents.publish(event),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function handleBrowserModelProviderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  settings: BrowserModelProviderSettings,
): Promise<boolean> {
  if (!pathname.startsWith('/ui/api/model-providers')) return false;

  const authentication = settings.authentication;
  const mode = authentication.mode;
  const originIsValid = isCanonicalBrowserOrigin(
    req,
    authentication.canonicalOrigin,
  );

  if (pathname === '/ui/api/model-providers') {
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
    if (
      !browserRoleAllowsScope(session.role as ConsoleRole, 'credentials:read')
    ) {
      sendError(res, 403, 'FORBIDDEN', 'Viewer access is required.');
      return true;
    }
    const service = modelCredentialService();
    const providers = await service.list({ appId: session.appId as AppId });
    const requiredBy = new Map<string, string[]>();
    for (const usage of requiredModelCredentialProviderUsage(settings, {
      configuredProviderIds: new Set(
        providers
          .filter((provider) => provider.configured)
          .map((provider) => provider.providerId),
      ),
    })) {
      requiredBy.set(usage.providerId, [
        ...(requiredBy.get(usage.providerId) ?? []),
        usage.reason,
      ]);
    }
    sendJson(res, 200, {
      providers: providers.map((provider) => ({
        ...provider,
        required: requiredBy.has(provider.providerId),
        requiredBy: [...new Set(requiredBy.get(provider.providerId) ?? [])],
      })),
    });
    return true;
  }

  const match = pathname.match(
    /^\/ui\/api\/model-providers\/([^/]+)(?:\/(verify|credential))?$/,
  );
  if (!match) {
    sendError(res, 404, 'NOT_FOUND', 'Model provider route not found.');
    return true;
  }
  const action = match[2];
  const verifying = action === 'verify';
  const removing = action === 'credential';
  if (
    (verifying && req.method !== 'POST') ||
    (removing && req.method !== 'DELETE') ||
    (!verifying &&
      !removing &&
      !['PUT', 'PATCH', 'DELETE'].includes(req.method ?? ''))
  ) {
    res.setHeader(
      'Allow',
      verifying ? 'POST' : removing ? 'DELETE' : 'PUT, PATCH, DELETE',
    );
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
  if (
    !browserRoleAllowsScope(session.role as ConsoleRole, 'credentials:admin')
  ) {
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
  let providerId: ReturnType<typeof normalizeModelCredentialProvider>;
  try {
    providerId = normalizeModelCredentialProvider(match[1]);
  } catch (error) {
    sendError(
      res,
      400,
      'INVALID_PROVIDER',
      error instanceof Error ? error.message : 'Invalid provider.',
      { supported: listSupportedModelCredentialProviders() },
    );
    return true;
  }
  const service = modelCredentialService();
  const actor = `browser:${session.userId}`;
  try {
    if (verifying) {
      const hasBody = Boolean(
        req.headers['content-length'] || req.headers['transfer-encoding'],
      );
      const candidate = hasBody ? await readModelCandidateBody(req, res) : null;
      if (hasBody && !candidate) return true;
      const appId = session.appId as AppId;
      if (candidate) {
        const model = resolveModelSelectionForWorkload(
          candidate.modelAlias,
          'chat',
        );
        if (!model.ok || model.entry.modelRoute.id !== providerId) {
          sendError(
            res,
            400,
            'INCOMPATIBLE_MODEL_PROVIDER',
            model.ok
              ? 'The selected model belongs to a different provider.'
              : model.message,
          );
          return true;
        }
        const route = resolveExecutionRoute({
          entry: model.entry,
          agentHarness: candidate.agentHarness,
        });
        if (
          !route.ok ||
          !route.value.supportedCredentialModes.includes(candidate.authMode)
        ) {
          sendError(
            res,
            400,
            'INCOMPATIBLE_CREDENTIAL_MODE',
            route.ok
              ? 'The selected credential mode is incompatible with this model and harness.'
              : route.message,
          );
          return true;
        }
        const outcome = await service.validateAndSet({
          appId,
          providerId,
          authMode: candidate.authMode,
          payload: candidate.payload,
          actor,
          validate: (modelCredentials) =>
            preflightModelProvider({
              runtimeHome: '',
              providerId,
              chatAlias: candidate.modelAlias,
              settings,
              modelCredentials,
              appId,
            }),
        });
        if (!outcome.credential) {
          sendError(
            res,
            400,
            'MODEL_CREDENTIAL_VALIDATION_FAILED',
            'Gantry could not validate this credential configuration. The saved credential was not changed.',
          );
          return true;
        }
        sendJson(res, 200, {
          status: 'pass',
          message: 'Configuration validated.',
          providerId,
          authMode: outcome.credential.authMode,
        });
        return true;
      }
      const result = await preflightModelProvider({
        runtimeHome: '',
        providerId,
        settings,
        modelCredentials: getRuntimeStorage().repositories.modelCredentials,
        appId,
      });
      sendJson(res, 200, {
        status: result.status,
        message:
          result.status === 'pass'
            ? 'Credential is available to Gantry.'
            : 'Gantry could not resolve this credential configuration. Check it and retry.',
      });
      return true;
    }
    if (removing) {
      await service.remove({
        appId: session.appId as AppId,
        providerId,
        actor,
      });
    } else if (req.method === 'DELETE') {
      await service.disable({
        appId: session.appId as AppId,
        providerId,
        actor,
      });
    } else {
      const body = await readModelProviderBody(req, res, req.method === 'PUT');
      if (!body) return true;
      if (req.method === 'PUT') {
        await service.set({
          appId: session.appId as AppId,
          providerId,
          authMode: body.authMode,
          payload: body.payload,
          actor,
        });
      } else {
        await service.rotate({
          appId: session.appId as AppId,
          providerId,
          payload: body.payload,
          actor,
          reactivateDisabled: true,
        });
      }
    }
    const provider = (
      await service.list({ appId: session.appId as AppId })
    ).find((item) => item.providerId === providerId);
    sendJson(res, 200, provider);
  } catch (error) {
    sendError(
      res,
      isCredentialSecretCryptoError(error) ? 500 : 400,
      isCredentialSecretCryptoError(error)
        ? 'CREDENTIAL_CRYPTO_UNAVAILABLE'
        : 'INVALID_REQUEST',
      isCredentialSecretCryptoError(error)
        ? 'Gantry credential encryption is unavailable.'
        : error instanceof Error
          ? error.message
          : 'Invalid credential request.',
    );
  }
  return true;
}

async function readModelCandidateBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{
  authMode: string;
  payload: Record<string, unknown>;
  modelAlias: string;
  agentHarness: AgentHarness;
} | null> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    sendError(res, 400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    return null;
  }
  if (
    !isObject(body) ||
    !isObject(body.payload) ||
    typeof body.authMode !== 'string' ||
    !body.authMode.trim() ||
    typeof body.modelAlias !== 'string' ||
    !body.modelAlias.trim() ||
    !isAgentHarness(body.agentHarness) ||
    Object.keys(body).some(
      (key) =>
        !['authMode', 'payload', 'modelAlias', 'agentHarness'].includes(key),
    )
  ) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'A complete model credential candidate is required.',
    );
    return null;
  }
  return {
    authMode: body.authMode.trim(),
    payload: body.payload,
    modelAlias: body.modelAlias.trim(),
    agentHarness: body.agentHarness,
  };
}

async function readModelProviderBody(
  req: IncomingMessage,
  res: ServerResponse,
  allowAuthMode: boolean,
): Promise<{ authMode?: string; payload: Record<string, unknown> } | null> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    sendError(res, 400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    return null;
  }
  if (!isObject(body) || !isObject(body.payload)) {
    sendError(res, 400, 'INVALID_REQUEST', 'payload is required.');
    return null;
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'payload' && key !== 'authMode')) {
    sendError(res, 400, 'INVALID_REQUEST', 'Unsupported request fields.');
    return null;
  }
  const authMode = body.authMode;
  if (!allowAuthMode && authMode !== undefined) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'PATCH cannot change credential authMode. Use PUT to replace the credential.',
    );
    return null;
  }
  if (
    authMode !== undefined &&
    (typeof authMode !== 'string' || !authMode.trim())
  ) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'authMode must be a non-empty string.',
    );
    return null;
  }
  return {
    ...(typeof authMode === 'string' ? { authMode: authMode.trim() } : {}),
    payload: body.payload,
  };
}
