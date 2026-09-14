import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { PostgresOnboardingSetupRepository } from '../../../adapters/storage/postgres/repositories/onboarding-setup-repository.postgres.js';
import {
  onboardingSetupsPostgres,
  onboardingVerificationsPostgres,
} from '../../../adapters/storage/postgres/schema/schema.js';
import { DEFAULT_AGENT_ID } from '../../../adapters/storage/postgres/seeds.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { isRecentlyReauthenticated } from '../../../application/auth/auth-foundations.js';
import { OnboardingSetupService } from '../../../application/onboarding/onboarding-setup.service.js';
import { channelSetupManifestFor } from '../../../channels/control-provider-catalog.js';
import type { AppId } from '../../../domain/app/app.js';
import { isAgentHarness } from '../../../shared/agent-engine.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import {
  readJson,
  sendApplicationError,
  sendError,
  sendJson,
} from '../http.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';

const ONBOARDING_STATUS_PATH = '/ui/api/onboarding/status';
const ONBOARDING_CHANNEL_MANIFEST_PATH = '/ui/api/onboarding/channel-manifest';
const ONBOARDING_VERIFICATIONS_PATH = '/ui/api/onboarding/verifications';
const ONBOARDING_SETUPS_PATH = '/ui/api/onboarding/setups';
const ONBOARDING_VERIFICATION_PATH =
  /^\/ui\/api\/onboarding\/verifications\/([^/]+)(?:\/(project))?$/;

type Settings = {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

export function onboardingChallengeText(agentName: string, challenge: string) {
  const handle =
    agentName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'agent';
  return `@${handle} are you there? · ${challenge}`;
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isBrowserOnboardingPath(pathname: string) {
  return (
    pathname === ONBOARDING_STATUS_PATH ||
    pathname === ONBOARDING_CHANNEL_MANIFEST_PATH ||
    pathname === ONBOARDING_SETUPS_PATH ||
    pathname === ONBOARDING_VERIFICATIONS_PATH ||
    ONBOARDING_VERIFICATION_PATH.test(pathname)
  );
}

export async function handleBrowserOnboardingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  settings: Settings,
  url?: URL,
): Promise<boolean> {
  if (!isBrowserOnboardingPath(pathname)) return false;
  if (pathname === ONBOARDING_CHANNEL_MANIFEST_PATH && req.method === 'GET') {
    return getChannelManifest(req, res, settings, url);
  }
  if (pathname === ONBOARDING_SETUPS_PATH && req.method === 'POST') {
    return createSetup(req, res, ctx, settings);
  }
  if (pathname === ONBOARDING_VERIFICATIONS_PATH && req.method === 'POST') {
    return createVerification(req, res, settings);
  }
  const verificationMatch = ONBOARDING_VERIFICATION_PATH.exec(pathname);
  if (verificationMatch?.[2] === 'project' && req.method === 'POST') {
    return projectVerification(req, res, ctx, settings, verificationMatch[1]);
  }
  if (verificationMatch && !verificationMatch[2] && req.method === 'GET') {
    return getVerification(req, res, settings, verificationMatch[1]);
  }
  if (pathname !== ONBOARDING_STATUS_PATH || req.method !== 'GET') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  }
  const session = await activeSession(req, settings.authentication.mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return true;
  }
  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  const now = new Date().toISOString();
  await storage.service.db
    .update(onboardingVerificationsPostgres)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(onboardingVerificationsPostgres.appId, appId),
        inArray(onboardingVerificationsPostgres.status, [
          'pending',
          'inbound_received',
        ]),
        lt(onboardingVerificationsPostgres.expiresAt, now),
      ),
    );
  const agents = await storage.repositories.agents.listAgents(appId);
  const onboardingAgents = agents.filter(
    (agent) => agent.id !== DEFAULT_AGENT_ID,
  );
  const accounts =
    await storage.repositories.providerAccounts.listProviderAccounts(appId);
  const setups = await storage.service.db
    .select({
      id: onboardingSetupsPostgres.id,
      agentId: onboardingSetupsPostgres.agentId,
    })
    .from(onboardingSetupsPostgres)
    .where(eq(onboardingSetupsPostgres.appId, appId));
  const setupAgentIds = new Set(setups.map((setup) => setup.agentId));
  const resumeCandidates = await Promise.all(
    onboardingAgents
      .filter((agent) => setupAgentIds.has(agent.id))
      .map(async (agent) => {
        const agentAccounts = accounts.filter(
          (item) => item.agentId === agent.id && item.status === 'active',
        );
        const installs =
          await storage.repositories.providerAccounts.listConversationInstalls(
            appId,
            agent.id,
          );
        const install = installs.find(
          (item) =>
            item.status === 'active' &&
            agentAccounts.some(
              (providerAccount) =>
                providerAccount.id === item.providerAccountId,
            ),
        );
        const account =
          agentAccounts.find(
            (providerAccount) =>
              providerAccount.id === install?.providerAccountId,
          ) ?? agentAccounts[0];
        const approver = install
          ? (
              await storage.repositories.conversations.listConversationApprovers(
                install.conversationId,
              )
            ).find((item) => item.personId)
          : undefined;
        const [verification] = await storage.service.db
          .select({
            id: onboardingVerificationsPostgres.id,
            challenge: onboardingVerificationsPostgres.challenge,
            status: onboardingVerificationsPostgres.status,
          })
          .from(onboardingVerificationsPostgres)
          .where(
            and(
              eq(onboardingVerificationsPostgres.appId, appId),
              eq(onboardingVerificationsPostgres.agentId, agent.id),
            ),
          )
          .orderBy(desc(onboardingVerificationsPostgres.createdAt))
          .limit(1);
        if (verification?.status === 'completed') return null;
        const activeVerification =
          verification?.status === 'pending' ||
          verification?.status === 'inbound_received' ||
          verification?.status === 'satisfied' ||
          verification?.status === 'projection_failed';
        return {
          id: agent.id,
          setupId: setups.find((setup) => setup.agentId === agent.id)!.id,
          name: agent.name,
          accountId: account?.id ?? null,
          channelId: account?.providerId ?? null,
          conversationId: install?.conversationId ?? null,
          approver: approver?.externalUserId ?? null,
          assignmentReady: Boolean(install && approver),
          verificationId: activeVerification ? verification.id : null,
          challenge: activeVerification ? verification.challenge : null,
          challengeText: activeVerification
            ? onboardingChallengeText(agent.name, verification.challenge)
            : null,
          hasWorkspace: Boolean(account),
        };
      }),
  );
  const resumable = resumeCandidates
    .flatMap((agent) => (agent ? [agent] : []))
    .map((agent) => ({
      ...agent,
      step: agent.verificationId ? 4 : agent.assignmentReady ? 3 : 2,
    }));
  sendJson(res, 200, {
    firstRun: onboardingAgents.length === 0,
    resume: resumable[0] ?? null,
  });
  return true;
}

async function getChannelManifest(
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
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

async function createSetup(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  settings: Settings,
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
  const agentHarness = payload.agentHarness;
  const idempotencyHeader = req.headers['idempotency-key'];
  const idempotencyKey = Array.isArray(idempotencyHeader)
    ? idempotencyHeader[0]
    : idempotencyHeader;
  if (
    typeof payload.name !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.modelAlias !== 'string' ||
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
    ).createOrResume({
      appId,
      actorId: session.userId,
      idempotencyKey,
      name: payload.name,
      title: payload.title,
      responsibilities,
      modelAlias: payload.modelAlias,
      agentHarness,
    });
    const folder = setup.agentId.replace(/^agent:/, '');
    await ctx.agentSettings.writeAgentModelSetting({
      runtimeHome: ctx.runtimeHome,
      appId,
      folder,
      name: setup.agentName,
      modelAlias: payload.modelAlias,
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

async function projectVerification(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  settings: Settings,
  id: string,
): Promise<boolean> {
  const session = await requireOnboardingAdministrator(req, res, settings);
  if (!session) return true;
  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  const [verification] = await storage.service.db
    .select()
    .from(onboardingVerificationsPostgres)
    .where(
      and(
        eq(onboardingVerificationsPostgres.id, id),
        eq(onboardingVerificationsPostgres.appId, appId),
      ),
    )
    .limit(1);
  if (!verification) {
    sendError(res, 404, 'NOT_FOUND', 'Verification not found.');
    return true;
  }
  if (
    verification.status !== 'satisfied' &&
    verification.status !== 'projection_failed'
  ) {
    sendError(
      res,
      409,
      'ONBOARDING_VERIFICATION_NOT_SATISFIED',
      'A correlated inbound message and reply are required before projection.',
    );
    return true;
  }
  const now = new Date().toISOString();
  try {
    await ctx.syncSettingsFromProjection(appId);
    await storage.service.db
      .update(onboardingVerificationsPostgres)
      .set({
        status: 'completed',
        projectionFailureCode: null,
        completedAt: now,
        updatedAt: now,
        updatedBy: session.userId,
      })
      .where(eq(onboardingVerificationsPostgres.id, id));
    sendJson(res, 200, { verification: { id, status: 'completed' } });
  } catch {
    await storage.service.db
      .update(onboardingVerificationsPostgres)
      .set({
        status: 'projection_failed',
        projectionFailureCode: 'RUNTIME_PROJECTION_FAILED',
        updatedAt: now,
        updatedBy: session.userId,
      })
      .where(eq(onboardingVerificationsPostgres.id, id));
    sendError(
      res,
      503,
      'RUNTIME_PROJECTION_FAILED',
      'The verified setup could not be projected. Retry projection.',
    );
  }
  return true;
}

async function getVerification(
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
  id: string,
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
  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  const now = new Date().toISOString();
  await storage.service.db
    .update(onboardingVerificationsPostgres)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(onboardingVerificationsPostgres.id, id),
        eq(onboardingVerificationsPostgres.appId, appId),
        inArray(onboardingVerificationsPostgres.status, [
          'pending',
          'inbound_received',
        ]),
        lt(onboardingVerificationsPostgres.expiresAt, now),
      ),
    );
  const [verification] = await storage.service.db
    .select()
    .from(onboardingVerificationsPostgres)
    .where(
      and(
        eq(onboardingVerificationsPostgres.id, id),
        eq(onboardingVerificationsPostgres.appId, appId),
      ),
    )
    .limit(1);
  if (!verification) {
    sendError(res, 404, 'NOT_FOUND', 'Verification not found.');
    return true;
  }
  sendJson(res, 200, {
    verification: {
      id: verification.id,
      status: verification.status,
      expiresAt: verification.expiresAt,
      satisfiedAt: verification.satisfiedAt,
      completedAt: verification.completedAt,
      failureCode:
        verification.status === 'expired'
          ? 'VERIFICATION_EXPIRED'
          : verification.status === 'pending' ||
              verification.status === 'inbound_received'
            ? 'VERIFICATION_PENDING'
            : verification.projectionFailureCode,
    },
  });
  return true;
}

async function createVerification(
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
): Promise<boolean> {
  const session = await requireOnboardingAdministrator(req, res, settings);
  if (!session) return true;
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    sendError(res, 400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    return true;
  }
  const payload =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
  const conversationId =
    typeof payload.conversationId === 'string' ? payload.conversationId : '';
  if (!agentId || !conversationId) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'A valid agent and conversation are required.',
    );
    return true;
  }
  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  const agent = await storage.repositories.agents.getAgent(agentId as never);
  const conversation = await storage.repositories.conversations.getConversation(
    conversationId as never,
  );
  if (
    !agent ||
    !conversation ||
    agent.appId !== appId ||
    conversation.appId !== appId
  ) {
    sendError(
      res,
      404,
      'NOT_FOUND',
      'The selected setup resources were not found.',
    );
    return true;
  }
  const installed =
    await storage.repositories.providerAccounts.isAgentEnabledInConversation({
      appId,
      agentId: agent.id,
      conversationId: conversation.id,
    });
  if (!installed) {
    sendError(
      res,
      409,
      'CONFLICT',
      'Install this employee in the selected conversation before verifying it.',
    );
    return true;
  }
  const [setup] = await storage.service.db
    .select({ id: onboardingSetupsPostgres.id })
    .from(onboardingSetupsPostgres)
    .where(
      and(
        eq(onboardingSetupsPostgres.appId, appId),
        eq(onboardingSetupsPostgres.agentId, agentId),
      ),
    )
    .limit(1);
  const installs =
    await storage.repositories.providerAccounts.listConversationInstalls(
      appId,
      agent.id,
    );
  const install = installs.find(
    (item) =>
      item.status === 'active' && item.conversationId === conversation.id,
  );
  if (!setup || !install) {
    sendError(res, 409, 'CONFLICT', 'The onboarding setup is incomplete.');
    return true;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await storage.service.db
    .update(onboardingVerificationsPostgres)
    .set({ status: 'expired', updatedAt: now.toISOString() })
    .where(
      and(
        eq(onboardingVerificationsPostgres.appId, appId),
        eq(onboardingVerificationsPostgres.conversationId, conversationId),
        inArray(onboardingVerificationsPostgres.status, [
          'pending',
          'inbound_received',
        ]),
        lt(onboardingVerificationsPostgres.expiresAt, now.toISOString()),
      ),
    );
  const [activeVerification] = await storage.service.db
    .select({ id: onboardingVerificationsPostgres.id })
    .from(onboardingVerificationsPostgres)
    .where(
      and(
        eq(onboardingVerificationsPostgres.appId, appId),
        eq(onboardingVerificationsPostgres.conversationId, conversationId),
        inArray(onboardingVerificationsPostgres.status, [
          'pending',
          'inbound_received',
        ]),
      ),
    )
    .limit(1);
  if (activeVerification) {
    sendError(
      res,
      409,
      'CONFLICT',
      'An active verification already exists for this conversation.',
    );
    return true;
  }
  const challenge = `GY-${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`;
  const id = randomUUID();
  try {
    await storage.service.db.insert(onboardingVerificationsPostgres).values({
      id,
      setupId: setup.id,
      appId,
      agentId,
      conversationId,
      challenge,
      providerAccountId: conversation.providerAccountId,
      threadId: install.threadId ?? null,
      status: 'pending',
      expiresAt,
      createdBy: session.userId,
      updatedBy: session.userId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    sendError(
      res,
      409,
      'CONFLICT',
      'An active verification already exists for this conversation.',
    );
    return true;
  }
  sendJson(res, 201, {
    verification: {
      id,
      challenge,
      challengeText: onboardingChallengeText(agent.name, challenge),
      status: 'pending',
      expiresAt,
    },
  });
  return true;
}

async function requireOnboardingAdministrator(
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
) {
  const session = await requireBrowserMutationSession({
    req,
    res,
    mode: settings.authentication.mode,
    originIsValid: isCanonicalBrowserOrigin(
      req,
      settings.authentication.canonicalOrigin,
    ),
  });
  if (!session) return null;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return null;
  }
  if (
    settings.authentication.mode === 'hosted' &&
    !isRecentlyReauthenticated(session.reauthenticatedAt)
  ) {
    sendError(
      res,
      401,
      'REAUTHENTICATION_REQUIRED',
      'Sign in again to continue.',
    );
    return null;
  }
  return session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
