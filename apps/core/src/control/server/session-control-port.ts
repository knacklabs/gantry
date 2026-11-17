import type { SessionControlPort } from '../../application/sessions/session-interaction-module.js';
import type { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';

type RuntimeControlRepository = ReturnType<typeof getRuntimeControlRepository>;
type RuntimeAppSession = Awaited<
  ReturnType<RuntimeControlRepository['getAppSessionById']>
>;

function adaptAppSession(session: RuntimeAppSession) {
  if (!session) return undefined;
  return {
    sessionId: session.sessionId,
    appId: session.appId,
    agentId: session.agentId,
    conversationId: session.conversationId,
    canonicalConversationId: session.canonicalConversationId,
    conversationJid: session.chatJid,
    workspaceKey: session.workspaceKey,
    title: session.title,
    defaultResponseMode: session.defaultResponseMode,
    defaultWebhookId: session.defaultWebhookId,
    appUser: session.appUser,
  };
}

export function adaptSessionControlPort(
  control: RuntimeControlRepository,
): SessionControlPort {
  return {
    configureSourceChannelProfile: (appId, agentId, profile, concurrency) =>
      control.configureSourceChannelProfile(
        appId,
        agentId,
        profile,
        concurrency,
      ),
    requestSourceAnswer: (appId, sessionId, input) =>
      control.requestSourceAnswer(appId, sessionId, input),
    settleSourceHistory: (appId, sessionId, input) =>
      control.settleSourceHistory(appId, sessionId, input),
    settleExecutionAuthority: (appId, sessionId, input) =>
      control.settleExecutionAuthority(appId, sessionId, input),
    appendSourceMessage: (appId, sessionId, input) =>
      control.appendSourceMessage(appId, sessionId, input),
    async ensureAppSession(input) {
      const session = await control.ensureAppSession({
        appId: input.appId,
        conversationId: input.conversationId,
        chatJid: input.conversationJid,
        workspaceFolder: input.folder,
        title: input.title,
        defaultResponseMode: input.defaultResponseMode,
        defaultWebhookId: input.defaultWebhookId,
        appUser: input.appUser,
      });
      return adaptAppSession(session)!;
    },
    async getAppSessionById(sessionId) {
      return adaptAppSession(await control.getAppSessionById(sessionId));
    },
    async getAppSessionByChatJid(conversationJid) {
      return adaptAppSession(
        await control.getAppSessionByChatJid(conversationJid),
      );
    },
    getWebhookById: (webhookId, appId) =>
      control.getWebhookById(webhookId, appId),
    upsertAppResponseRoute: (input) => control.upsertAppResponseRoute(input),
    getAppResponseRoute: (input) => control.getAppResponseRoute(input),
  };
}
