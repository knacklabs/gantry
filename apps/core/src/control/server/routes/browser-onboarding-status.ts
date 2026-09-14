import type { IncomingMessage, ServerResponse } from 'node:http';

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import {
  onboardingSetupsPostgres,
  onboardingVerificationsPostgres,
} from '../../../adapters/storage/postgres/schema/schema.js';
import { DEFAULT_AGENT_ID } from '../../../adapters/storage/postgres/seeds.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import type { AppId } from '../../../domain/app/app.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import { sendError, sendJson } from '../http.js';
import { activeSession } from './browser-auth.js';
import { onboardingChallengeText } from './browser-onboarding-challenge.js';
import type { BrowserOnboardingSettings } from './browser-onboarding-auth.js';

export async function getOnboardingStatus(
  req: IncomingMessage,
  res: ServerResponse,
  settings: BrowserOnboardingSettings,
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
        const activeVerification = [
          'pending',
          'inbound_received',
          'satisfied',
          'projection_failed',
        ].includes(verification?.status ?? '');
        return {
          id: agent.id,
          setupId: setups.find((setup) => setup.agentId === agent.id)!.id,
          name: agent.name,
          accountId: account?.id ?? null,
          channelId: account?.providerId ?? null,
          conversationId: install?.conversationId ?? null,
          approver: approver?.externalUserId ?? null,
          assignmentReady: Boolean(install && approver),
          verificationId: activeVerification ? verification!.id : null,
          challenge: activeVerification ? verification!.challenge : null,
          challengeText: activeVerification
            ? onboardingChallengeText(agent.name, verification!.challenge)
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
