import type { SessionControlPort } from '../../application/sessions/session-interaction-module.js';
import type { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';

type RuntimeControlRepository = ReturnType<typeof getRuntimeControlRepository>;

export function adaptSessionControlPort(
  control: RuntimeControlRepository,
): SessionControlPort {
  return {
    async ensureAppSession(input) {
      return control.ensureAppSession({
        appId: input.appId,
        conversationId: input.conversationId,
        chatJid: input.chatJid,
        groupFolder: input.folder,
        title: input.title,
        defaultResponseMode: input.defaultResponseMode,
        defaultWebhookId: input.defaultWebhookId,
      });
    },
    getAppSessionById: (sessionId) => control.getAppSessionById(sessionId),
    getAppSessionByChatJid: (chatJid) =>
      control.getAppSessionByChatJid(chatJid),
    getWebhookById: (webhookId, appId) =>
      control.getWebhookById(webhookId, appId),
    upsertAppResponseRoute: (input) => control.upsertAppResponseRoute(input),
    getAppResponseRoute: (input) => control.getAppResponseRoute(input),
  };
}
