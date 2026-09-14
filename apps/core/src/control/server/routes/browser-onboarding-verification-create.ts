import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { and, eq, inArray, lt } from 'drizzle-orm';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import {
  onboardingSetupsPostgres,
  onboardingVerificationsPostgres,
} from '../../../adapters/storage/postgres/schema/schema.js';
import type { AppId } from '../../../domain/app/app.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  requireOnboardingAdministrator,
  type BrowserOnboardingSettings,
} from './browser-onboarding-auth.js';
import { onboardingChallengeText } from './browser-onboarding-challenge.js';

export async function createOnboardingVerification(
  req: IncomingMessage,
  res: ServerResponse,
  settings: BrowserOnboardingSettings,
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
  const payload = isRecord(body) ? body : {};
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
  const [agent, conversation] = await Promise.all([
    storage.repositories.agents.getAgent(agentId as never),
    storage.repositories.conversations.getConversation(conversationId as never),
  ]);
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
  const [setup, installs, approvers] = await Promise.all([
    storage.service.db
      .select({ id: onboardingSetupsPostgres.id })
      .from(onboardingSetupsPostgres)
      .where(
        and(
          eq(onboardingSetupsPostgres.appId, appId),
          eq(onboardingSetupsPostgres.agentId, agentId),
        ),
      )
      .limit(1),
    storage.repositories.providerAccounts.listConversationInstalls(
      appId,
      agent.id,
    ),
    storage.repositories.conversations.listConversationApprovers(
      conversation.id,
    ),
  ]);
  const install = installs.find(
    (item) =>
      item.status === 'active' && item.conversationId === conversation.id,
  );
  if (!setup[0] || !install || !approvers.some((item) => item.personId)) {
    sendError(
      res,
      409,
      'CONFLICT',
      'Assign a verified approver before preparing the test message.',
    );
    return true;
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await storage.service.db
    .update(onboardingVerificationsPostgres)
    .set({ status: 'expired', updatedAt: nowIso })
    .where(
      and(
        eq(onboardingVerificationsPostgres.appId, appId),
        eq(onboardingVerificationsPostgres.conversationId, conversationId),
        inArray(onboardingVerificationsPostgres.status, [
          'pending',
          'inbound_received',
        ]),
        lt(onboardingVerificationsPostgres.expiresAt, nowIso),
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
      setupId: setup[0].id,
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
      createdAt: nowIso,
      updatedAt: nowIso,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(current)) return false;
    if (current.code === '23505') return true;
    current = current.cause;
  }
  return false;
}
