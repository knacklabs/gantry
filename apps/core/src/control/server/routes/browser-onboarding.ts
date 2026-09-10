import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { onboardingVerificationsPostgres } from '../../../adapters/storage/postgres/schema/schema.js';
import { DEFAULT_AGENT_ID } from '../../../adapters/storage/postgres/seeds.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import type { AppId } from '../../../domain/app/app.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import { readJson, sendError, sendJson } from '../http.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';

const ONBOARDING_STATUS_PATH = '/ui/api/onboarding/status';
const ONBOARDING_VERIFICATIONS_PATH = '/ui/api/onboarding/verifications';
const ONBOARDING_VERIFICATION_PATH =
  /^\/ui\/api\/onboarding\/verifications\/([^/]+)$/;

type Settings = {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

export function isBrowserOnboardingPath(pathname: string) {
  return (
    pathname === ONBOARDING_STATUS_PATH ||
    pathname === ONBOARDING_VERIFICATIONS_PATH ||
    ONBOARDING_VERIFICATION_PATH.test(pathname)
  );
}

export async function handleBrowserOnboardingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  settings: Settings,
): Promise<boolean> {
  if (!isBrowserOnboardingPath(pathname)) return false;
  if (pathname === ONBOARDING_VERIFICATIONS_PATH && req.method === 'POST') {
    return createVerification(req, res, settings);
  }
  const verificationMatch = ONBOARDING_VERIFICATION_PATH.exec(pathname);
  if (verificationMatch && req.method === 'GET') {
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
  const agents = await storage.repositories.agents.listAgents(appId);
  const onboardingAgents = agents.filter((agent) => agent.id !== DEFAULT_AGENT_ID);
  const accounts =
    await storage.repositories.providerAccounts.listProviderAccounts(appId);
  const resumeCandidates = await Promise.all(
    onboardingAgents.map(async (agent) => {
      const account = accounts.find((item) => item.agentId === agent.id);
      const [verification] = await storage.service.db
        .select({
          id: onboardingVerificationsPostgres.id,
          challenge: onboardingVerificationsPostgres.challenge,
        })
        .from(onboardingVerificationsPostgres)
        .where(
          and(
            eq(onboardingVerificationsPostgres.appId, appId),
            eq(onboardingVerificationsPostgres.agentId, agent.id),
            inArray(onboardingVerificationsPostgres.status, [
              'pending',
              'inbound_received',
            ]),
          ),
        )
        .orderBy(desc(onboardingVerificationsPostgres.createdAt))
        .limit(1);
      return {
        id: agent.id,
        name: agent.name,
        accountId: account?.id ?? null,
        verificationId: verification?.id ?? null,
        challenge: verification?.challenge ?? null,
        hasWorkspace: Boolean(account),
      };
    }),
  );
  const resumable = resumeCandidates.map((agent) => ({
    ...agent,
    step: agent.verificationId ? 4 : agent.hasWorkspace ? 3 : 2,
  }));
  sendJson(res, 200, {
    firstRun: onboardingAgents.length === 0,
    resume: resumable[0] ?? null,
  });
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
      completedAt: verification.completedAt,
    },
  });
  return true;
}

async function createVerification(
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
): Promise<boolean> {
  const session = await requireBrowserMutationSession({
    req,
    res,
    mode: settings.authentication.mode,
    originIsValid: isCanonicalBrowserOrigin(
      req,
      settings.authentication.canonicalOrigin,
    ),
  });
  if (!session) return true;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return true;
  }
  const body = await readJson(req);
  const payload =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
  const conversationId =
    typeof payload.conversationId === 'string' ? payload.conversationId : '';
  const challenge =
    typeof payload.challenge === 'string' ? payload.challenge : '';
  if (!agentId || !conversationId || !/^GY-[A-Z0-9]{5}$/.test(challenge)) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'A valid agent, conversation, and challenge are required.',
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
  const id = `onboarding-verification:${randomUUID()}`;
  await storage.service.db.insert(onboardingVerificationsPostgres).values({
    id,
    appId,
    agentId,
    conversationId,
    challenge,
    status: 'pending',
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  sendJson(res, 201, {
    verification: { id, challenge, status: 'pending', expiresAt },
  });
  return true;
}
