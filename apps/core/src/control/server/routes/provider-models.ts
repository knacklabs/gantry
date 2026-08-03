import type { IncomingMessage, ServerResponse } from 'node:http';

import { RegisterProviderModelRequestSchema } from '@gantry/contracts';

import {
  ProviderModelDiscoveryError,
  ProviderModelRegistrationError,
} from '../../../application/models/provider-model-discovery-service.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { AppId } from '../../../domain/app/app.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import { writeControlDesiredState } from './settings.js';

export async function handleProviderModelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  const providerMatch = /^\/v1\/model-providers\/([^/]+)\/models$/.exec(
    pathname,
  );
  if (providerMatch) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    if (!ctx.providerModels) {
      sendError(res, 503, 'UNAVAILABLE', 'Model discovery is unavailable.');
      return true;
    }
    try {
      const force =
        new URL(req.url ?? pathname, 'http://localhost').searchParams.get(
          'refresh',
        ) === 'true';
      sendJson(
        res,
        200,
        await ctx.providerModels.list({
          appId: auth.appId as AppId,
          providerId: providerMatch[1]!,
          ...(force ? { force: true } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof ProviderModelDiscoveryError) {
        sendError(res, 400, error.code, error.message);
        return true;
      }
      throw error;
    }
    return true;
  }
  if (pathname !== '/v1/model-registrations') return false;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }
  const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
  if (!auth) return true;
  if (!ctx.providerModels) {
    sendError(res, 503, 'UNAVAILABLE', 'Model registration is unavailable.');
    return true;
  }
  const parsed = RegisterProviderModelRequestSchema.safeParse(
    await readJson(req),
  );
  if (!parsed.success) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      parsed.error.issues[0]?.message ?? 'Invalid registration request.',
    );
    return true;
  }
  const appId = auth.appId as AppId;
  const latest =
    await getRuntimeStorage().repositories.settingsRevisions.getLatestSettingsRevision(
      appId,
    );
  const actualRevision = latest?.revision ?? 0;
  if (parsed.data.expectedRevision !== actualRevision) {
    sendError(
      res,
      409,
      'REVISION_CONFLICT',
      `expectedRevision ${parsed.data.expectedRevision} does not match the current revision ${actualRevision}.`,
      { expectedRevision: parsed.data.expectedRevision, actualRevision },
    );
    return true;
  }
  if (!latest) {
    sendError(
      res,
      409,
      'SETTINGS_NOT_INITIALIZED',
      'Initialize desired settings before registering a model.',
    );
    return true;
  }
  const currentAliases = latest.settingsDocument.model_aliases;
  const modelAliases =
    currentAliases &&
    typeof currentAliases === 'object' &&
    !Array.isArray(currentAliases)
      ? (currentAliases as Record<string, unknown>)
      : {};
  if (Object.hasOwn(modelAliases, parsed.data.alias)) {
    sendError(
      res,
      409,
      'MODEL_ALIAS_EXISTS',
      `Model alias ${parsed.data.alias} is already registered.`,
    );
    return true;
  }
  try {
    const registration = await ctx.providerModels.prepareRegistration({
      appId,
      providerId: parsed.data.providerId,
      providerModelId: parsed.data.providerModelId,
      alias: parsed.data.alias,
    });
    await writeControlDesiredState({
      res,
      ctx,
      key: auth,
      body: {
        settings: {
          ...latest.settingsDocument,
          model_aliases: {
            ...modelAliases,
            [registration.alias]: registration.value,
          },
        },
        expectedRevision: parsed.data.expectedRevision,
        note: `Register model alias ${registration.alias}`,
      },
      respond: (revision) =>
        sendJson(res, 200, {
          revision,
          alias: registration.alias,
          providerId: parsed.data.providerId,
          providerModelId: parsed.data.providerModelId,
        }),
    });
  } catch (error) {
    if (
      error instanceof ProviderModelRegistrationError ||
      error instanceof ProviderModelDiscoveryError
    ) {
      sendError(res, 400, error.code, error.message);
      return true;
    }
    throw error;
  }
  return true;
}
