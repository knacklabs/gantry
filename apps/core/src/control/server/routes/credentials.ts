import type { IncomingMessage, ServerResponse } from 'node:http';

import { CapabilitySecretService } from '../../../application/capability-secrets/capability-secret-service.js';
import { ModelCredentialService } from '../../../application/model-credentials/model-credential-service.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { isCredentialSecretCryptoError } from '../../../adapters/storage/postgres/repositories/credential-secret-crypto.js';
import type { AppId } from '../../../domain/app/app.js';
import {
  listSupportedModelCredentialProviders,
  normalizeModelCredentialProvider,
} from '../../../domain/model-credentials/model-credentials.js';
import {
  getModelProviderDefinition,
  resolveModelCredentialMode,
} from '../../../shared/model-provider-registry.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

function modelCredentialService(): ModelCredentialService {
  const storage = getRuntimeStorage();
  return new ModelCredentialService(
    storage.repositories.modelCredentials,
    (event) => storage.runtimeEvents.publish(event),
  );
}

function capabilityCredentialService(): CapabilitySecretService {
  const storage = getRuntimeStorage();
  return new CapabilitySecretService(
    storage.repositories.capabilitySecrets,
    (event) => storage.runtimeEvents.publish(event),
  );
}

export async function handleCredentialRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname.startsWith('/v1/credentials/capabilities/')) {
    return handleCapabilityCredentialRoute(req, res, ctx, pathname);
  }
  if (
    pathname !== '/v1/credentials/models' &&
    !pathname.startsWith('/v1/credentials/models/')
  ) {
    return false;
  }

  if (pathname === '/v1/credentials/models') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'credentials:read',
    ]);
    if (!auth) return true;
    const appId = auth.appId as AppId;
    sendJson(res, 200, {
      providers: await modelCredentialService().list({ appId }),
    });
    return true;
  }

  const parts = pathname.split('/').filter(Boolean);
  if (
    parts.length !== 4 ||
    parts[0] !== 'v1' ||
    parts[1] !== 'credentials' ||
    parts[2] !== 'models'
  ) {
    sendError(res, 404, 'NOT_FOUND', 'Model credential route not found.');
    return true;
  }

  if (!['PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
    res.setHeader('Allow', 'PUT, PATCH, DELETE');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }

  const auth = authorizeControlRequest(req, res, ctx.keys, [
    'credentials:admin',
  ]);
  if (!auth) return true;
  const appId = auth.appId as AppId;

  const providerId = parts[3] || '';
  let normalizedProvider: ReturnType<typeof normalizeModelCredentialProvider>;
  try {
    normalizedProvider = normalizeModelCredentialProvider(providerId);
  } catch (error) {
    sendError(
      res,
      400,
      'INVALID_PROVIDER',
      error instanceof Error ? error.message : 'Invalid provider',
      { supported: listSupportedModelCredentialProviders() },
    );
    return true;
  }

  if (req.method === 'PUT') {
    const rawBody = await readCredentialJson(req, res);
    if (rawBody === undefined) return true;
    if (
      typeof rawBody !== 'object' ||
      rawBody === null ||
      Array.isArray(rawBody)
    ) {
      sendError(res, 400, 'INVALID_REQUEST', 'Request body must be JSON.');
      return true;
    }
    const payload = (rawBody as { payload?: unknown }).payload;
    const authMode = (rawBody as { authMode?: unknown }).authMode;
    const unknown = unknownKeys(rawBody as Record<string, unknown>, [
      'authMode',
      'payload',
    ]);
    if (unknown.length > 0) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        `Unsupported request field(s): ${unknown.join(', ')}.`,
      );
      return true;
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      sendError(res, 400, 'INVALID_REQUEST', 'payload is required.');
      return true;
    }
    if (
      authMode !== undefined &&
      (typeof authMode !== 'string' ||
        !authMode.trim() ||
        authMode.trim().length > 64)
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'authMode must be a non-empty string.',
      );
      return true;
    }
    if (typeof authMode === 'string') {
      try {
        const provider = getModelProviderDefinition(normalizedProvider);
        if (!provider) throw new Error('Unsupported model provider.');
        resolveModelCredentialMode(provider, authMode);
      } catch (error) {
        sendError(
          res,
          400,
          'INVALID_REQUEST',
          error instanceof Error ? error.message : 'Invalid authMode.',
        );
        return true;
      }
    }
    try {
      const service = modelCredentialService();
      await service.set({
        appId,
        providerId: normalizedProvider,
        ...(authMode ? { authMode: authMode.trim() } : {}),
        payload,
        actor: `control-api:${auth.kid}`,
      });
      sendJson(
        res,
        200,
        await redactedProviderStatus(service, appId, normalizedProvider),
      );
    } catch (error) {
      sendCredentialMutationError(res, error);
    }
    return true;
  }

  if (req.method === 'PATCH') {
    const rawBody = await readCredentialJson(req, res);
    if (rawBody === undefined) return true;
    if (
      typeof rawBody !== 'object' ||
      rawBody === null ||
      Array.isArray(rawBody)
    ) {
      sendError(res, 400, 'INVALID_REQUEST', 'Request body must be JSON.');
      return true;
    }
    const unknown = unknownKeys(rawBody as Record<string, unknown>, [
      'authMode',
      'payload',
    ]);
    if (unknown.length > 0) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        `Unsupported request field(s): ${unknown.join(', ')}.`,
      );
      return true;
    }
    if (Object.hasOwn(rawBody, 'authMode')) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'PATCH cannot change credential authMode. Use PUT to replace the credential.',
      );
      return true;
    }
    const payload = (rawBody as { payload?: unknown }).payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      sendError(res, 400, 'INVALID_REQUEST', 'payload is required.');
      return true;
    }
    try {
      const service = modelCredentialService();
      await service.rotate({
        appId,
        providerId: normalizedProvider,
        payload,
        actor: `control-api:${auth.kid}`,
      });
      sendJson(
        res,
        200,
        await redactedProviderStatus(service, appId, normalizedProvider),
      );
    } catch (error) {
      sendCredentialMutationError(res, error);
    }
    return true;
  }

  if (req.method === 'DELETE') {
    const service = modelCredentialService();
    await service.disable({
      appId,
      providerId: normalizedProvider,
      actor: `control-api:${auth.kid}`,
    });
    sendJson(
      res,
      200,
      await redactedProviderStatus(service, appId, normalizedProvider),
    );
    return true;
  }

  return true;
}

async function handleCapabilityCredentialRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  const parts = pathname.split('/').filter(Boolean);
  if (
    parts.length !== 4 ||
    parts[0] !== 'v1' ||
    parts[1] !== 'credentials' ||
    parts[2] !== 'capabilities'
  ) {
    sendError(res, 404, 'NOT_FOUND', 'Capability credential route not found.');
    return true;
  }
  if (!['GET', 'PUT', 'DELETE'].includes(req.method ?? '')) {
    res.setHeader('Allow', 'GET, PUT, DELETE');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }
  const auth = authorizeControlRequest(req, res, ctx.keys, [
    req.method === 'GET' ? 'credentials:read' : 'credentials:admin',
  ]);
  if (!auth) return true;
  const appId = auth.appId as AppId;
  let name: string;
  try {
    name = decodeURIComponent(parts[3] ?? '');
  } catch {
    sendError(res, 400, 'INVALID_REQUEST', 'Invalid credential name.');
    return true;
  }
  const service = capabilityCredentialService();
  try {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        credential: await service.inspect({ appId, name }),
      });
      return true;
    }
    if (req.method === 'DELETE') {
      await service.unset({ appId, name, actor: `control-api:${auth.kid}` });
      sendJson(res, 200, {
        credential: await service.inspect({ appId, name }),
      });
      return true;
    }
    const rawBody = await readCredentialJson(req, res);
    if (rawBody === undefined) return true;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      sendError(res, 400, 'INVALID_REQUEST', 'Request body must be JSON.');
      return true;
    }
    const body = rawBody as Record<string, unknown>;
    const unknown = unknownKeys(body, ['value', 'allowedCapabilityIds']);
    const allowedCapabilityIds = body.allowedCapabilityIds;
    if (
      unknown.length > 0 ||
      typeof body.value !== 'string' ||
      !body.value ||
      body.value.length > 65_536 ||
      (allowedCapabilityIds !== undefined &&
        (!Array.isArray(allowedCapabilityIds) ||
          allowedCapabilityIds.length > 100 ||
          allowedCapabilityIds.some((value) => typeof value !== 'string')))
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'value and optional string[] allowedCapabilityIds are required.',
      );
      return true;
    }
    await service.set({
      appId,
      name,
      value: body.value,
      actor: `control-api:${auth.kid}`,
      ...(allowedCapabilityIds
        ? { allowedCapabilityIds: allowedCapabilityIds as string[] }
        : {}),
    });
    sendJson(res, 200, { credential: await service.inspect({ appId, name }) });
  } catch (error) {
    sendCredentialMutationError(res, error);
  }
  return true;
}

function unknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(raw)
    .filter((key) => !allowedSet.has(key))
    .sort();
}

async function redactedProviderStatus(
  service: ModelCredentialService,
  appId: AppId,
  providerId: ReturnType<typeof normalizeModelCredentialProvider>,
) {
  const row = (await service.list({ appId })).find(
    (item) => item.providerId === providerId,
  );
  if (!row) {
    throw new Error(
      `Model credential provider ${providerId} is not supported.`,
    );
  }
  return row;
}

async function readCredentialJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | undefined> {
  try {
    return await readJson(req);
  } catch (error) {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 400;
    const code =
      (error as { code?: unknown }).code === 'PAYLOAD_TOO_LARGE'
        ? 'PAYLOAD_TOO_LARGE'
        : 'INVALID_REQUEST';
    sendError(
      res,
      statusCode,
      code,
      error instanceof Error ? error.message : 'Invalid request body.',
    );
    return undefined;
  }
}

function sendCredentialMutationError(
  res: ServerResponse,
  error: unknown,
): void {
  if (isCredentialSecretCryptoError(error)) {
    sendError(
      res,
      500,
      'CREDENTIAL_CRYPTO_UNAVAILABLE',
      'Gantry credential encryption is unavailable.',
    );
    return;
  }
  sendError(
    res,
    400,
    'INVALID_REQUEST',
    error instanceof Error ? error.message : 'Invalid credential request.',
  );
}
