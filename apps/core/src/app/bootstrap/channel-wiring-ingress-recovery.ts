import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { ConversationId } from '../../domain/conversation/conversation.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { systemPrincipal } from '../../domain/identity/principal-ref.js';
import type { ConversationIngressRecovery } from '../../domain/ports/conversation-ingress-cursor.js';
import type { ConversationIngressCursorRepository } from '../../domain/ports/conversation-ingress-cursor.js';
import type {
  ConversationRepository,
  ProviderAccountRepository,
} from '../../domain/ports/repositories.js';
import { nowIso } from '../../shared/time/datetime.js';

export function createConversationIngressRecovery(input: {
  appId: AppId;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown>;
  repositories: () => {
    providerAccounts: ProviderAccountRepository;
    conversations: ConversationRepository;
    conversationIngressCursors: ConversationIngressCursorRepository;
  };
}): ConversationIngressRecovery {
  return {
    async listTargets(providerAccountId) {
      const repositories = input.repositories();
      const installs =
        await repositories.providerAccounts.listConversationInstalls(
          input.appId,
        );
      const targets = await Promise.all(
        installs
          .filter(
            (install) =>
              install.providerAccountId === providerAccountId &&
              install.status === 'active',
          )
          .map(async (install) => {
            const conversation =
              await repositories.conversations.getConversation(
                install.conversationId,
              );
            const externalConversationId = String(
              install.externalConversationId ??
                conversation?.externalRef?.value ??
                '',
            ).trim();
            if (
              !conversation ||
              conversation.status !== 'active' ||
              !externalConversationId
            ) {
              return null;
            }
            return {
              agentId: String(install.agentId),
              providerAccountId: String(install.providerAccountId),
              conversationId: String(install.conversationId),
              externalConversationId,
              installedAt: String(install.createdAt),
            };
          }),
      );
      return [
        ...new Map(
          targets
            .filter(
              (target): target is NonNullable<typeof target> => target !== null,
            )
            .map((target) => [target.conversationId, target]),
        ).values(),
      ];
    },
    getCursor(target) {
      return input.repositories().conversationIngressCursors.get({
        providerAccountId: target.providerAccountId,
        conversationId: target.conversationId,
      });
    },
    async advanceCursor(cursor) {
      const result = await input
        .repositories()
        .conversationIngressCursors.advance({
          providerAccountId: cursor.target.providerAccountId,
          conversationId: cursor.target.conversationId,
          expectedVersion: cursor.expectedVersion,
          coveredThroughExternalId: cursor.coveredThroughExternalId,
          coveredThroughTimestamp: cursor.coveredThroughTimestamp,
          updatedAt: nowIso(),
        });
      return result.status;
    },
    async publish(event) {
      await input.publishRuntimeEvent?.({
        appId: input.appId,
        agentId: event.target.agentId as AgentId,
        conversationId: event.target.conversationId as ConversationId,
        eventType: event.eventType,
        actor: systemPrincipal('runtime:channel-replay'),
        responseMode: 'none',
        payload: {
          providerAccountId: event.target.providerAccountId,
          conversationId: event.target.conversationId,
          ...event.payload,
        },
      });
    },
  };
}
