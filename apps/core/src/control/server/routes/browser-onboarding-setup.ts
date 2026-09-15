import type { IncomingMessage, ServerResponse } from 'node:http';

import { preflightModelProvider } from '../../../adapters/llm/model-provider-preflight.js';
import { PostgresOnboardingSetupRepository } from '../../../adapters/storage/postgres/repositories/onboarding-setup-repository.postgres.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { OnboardingSetupService } from '../../../application/onboarding/onboarding-setup.service.js';
import { channelSetupManifestFor } from '../../../channels/control-provider-catalog.js';
import type { AppId } from '../../../domain/app/app.js';
import { isAgentHarness } from '../../../shared/agent-engine.js';
import type { ControlRouteContext } from '../handler-context.js';
import {
  readJson,
  sendApplicationError,
  sendError,
  sendJson,
} from '../http.js';
import { activeSession } from './browser-auth.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import {
  requireOnboardingAdministrator,
  type BrowserOnboardingSettings,
} from './browser-onboarding-auth.js';

export async function getOnboardingChannelManifest(
  req: IncomingMessage,
  res: ServerResponse,
  settings: BrowserOnboardingSettings,
  url?: URL,
): Promise<boolean> {
  const session = await activeSession(req, settings.authentication.mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return true;
  }
  const manifest = channelSetupManifestFor(
    url?.searchParams.get('providerId') ?? '',
    url?.searchParams.get('employeeName') ?? '',
  );
  if (!manifest) {
    sendError(res, 404, 'NOT_FOUND', 'No setup manifest is available.');
    return true;
  }
  sendJson(res, 200, manifest);
  return true;
}

export async function createOnboardingSetup(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  settings: BrowserOnboardingSettings,
): Promise<boolean> {
  const session = await requireOnboardingAdministrator(req, res, settings);
  if (!session) return true;
  let value: unknown;
  try {
    value = await readJson(req);
  } catch {
    sendError(res, 400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    return true;
  }
  const payload = isRecord(value) ? value : {};
  const responsibilities = Array.isArray(payload.responsibilities)
    ? payload.responsibilities.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const modelAlias =
    typeof payload.modelAlias === 'string' ? payload.modelAlias.trim() : '';
  const agentHarness = payload.agentHarness;
  const idempotencyHeader = req.headers['idempotency-key'];
  const idempotencyKey = Array.isArray(idempotencyHeader)
    ? idempotencyHeader[0]
    : idempotencyHeader;
  if (
    typeof payload.name !== 'string' ||
    typeof payload.title !== 'string' ||
    !modelAlias ||
    !isAgentHarness(agentHarness) ||
    !idempotencyKey
  ) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Complete employee, model, harness, and idempotency details are required.',
    );
    return true;
  }
  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  try {
    const setup = await new OnboardingSetupService(
      new PostgresOnboardingSetupRepository(storage.service.db),
      async ({ appId: candidateAppId, modelAlias, providerId }) =>
        preflightModelProvider({
          runtimeHome: ctx.runtimeHome,
          providerId,
          chatAlias: modelAlias,
          settings,
          modelCredentials: storage.repositories.modelCredentials,
          appId: candidateAppId,
        }),
    ).createOrResume({
      appId,
      actorId: session.userId,
      idempotencyKey,
      name: payload.name,
      title: payload.title,
      responsibilities,
      modelAlias,
      agentHarness,
    });
    const folder = setup.agentId.replace(/^agent:/, '');
    await ctx.agentSettings.writeAgentModelSetting({
      runtimeHome: ctx.runtimeHome,
      appId,
      folder,
      name: setup.agentName,
      modelAlias,
    });
    await ctx.agentSettings.writeAgentHarnessSetting({
      runtimeHome: ctx.runtimeHome,
      appId,
      folder,
      name: setup.agentName,
      agentHarness,
    });
    await ctx.syncSettingsFromProjection(appId);
    sendJson(res, setup.replayed ? 200 : 201, {
      setup: {
        id: setup.setupId,
        desiredStateRevision: setup.desiredStateRevision,
        replayed: setup.replayed,
      },
      agent: { id: setup.agentId, name: setup.agentName },
    });
  } catch (error) {
    if (!sendApplicationError(res, error)) throw error;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
