import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { and, eq, lt } from 'drizzle-orm';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { onboardingVerificationsPostgres } from '../../../adapters/storage/postgres/schema/schema.js';
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
const ONBOARDING_VERIFICATION_PATH = /^\/ui\/api\/onboarding\/verifications\/([^/]+)$/;

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
  const agents = await storage.repositories.agents.listAgents(
    session.appId as AppId,
  );
  const accounts =
    await storage.repositories.providerAccounts.listProviderAccounts(
      session.appId as AppId,
    );
  const resumable = agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      hasWorkspace: accounts.some((account) => account.agentId === agent.id),
    }))
    .filter((agent) => !agent.hasWorkspace);
  sendJson(res, 200, {
    firstRun: agents.length === 0,
    resume: resumable[0] ?? null,
  });
  return true;
}

async function getVerification(req: IncomingMessage, res: ServerResponse, settings: Settings, id: string): Promise<boolean> {
  const session = await activeSession(req, settings.authentication.mode);
  if (!session) { sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.'); return true; }
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) { sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.'); return true; }
  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  const now = new Date().toISOString();
  await storage.service.db.update(onboardingVerificationsPostgres).set({ status: 'expired', updatedAt: now }).where(and(eq(onboardingVerificationsPostgres.id, id), eq(onboardingVerificationsPostgres.appId, appId), eq(onboardingVerificationsPostgres.status, 'pending'), lt(onboardingVerificationsPostgres.expiresAt, now)));
  const [verification] = await storage.service.db.select().from(onboardingVerificationsPostgres).where(and(eq(onboardingVerificationsPostgres.id, id), eq(onboardingVerificationsPostgres.appId, appId))).limit(1);
  if (!verification) { sendError(res, 404, 'NOT_FOUND', 'Verification not found.'); return true; }
  sendJson(res, 200, { verification: { id: verification.id, status: verification.status, expiresAt: verification.expiresAt, completedAt: verification.completedAt } });
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
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
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
