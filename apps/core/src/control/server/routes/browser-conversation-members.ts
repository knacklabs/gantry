import type { ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { createRepositoryRuntimeSecretProvider } from '../../../adapters/credentials/repository-runtime-secret-provider.js';
import { ConversationAdministrationService } from '../../../application/provider-conversations/conversation-administration-service.js';
import { RuntimeSecretConversationMembershipValidator } from '../../../channels/conversation-membership-validation.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ConversationId } from '../../../domain/conversation/conversation.js';
import { sendApplicationError, sendJson } from '../http.js';

export async function sendBrowserConversationMembers(
  res: ServerResponse,
  appId: AppId,
  conversationId: ConversationId,
): Promise<void> {
  try {
    const members = await createBrowserConversationAdministrationService(
      appId,
    ).listConversationMembers({ appId, conversationId });
    sendJson(res, 200, { members });
  } catch (error) {
    if (!sendApplicationError(res, error)) throw error;
  }
}

export async function sendBrowserJoinConversation(
  res: ServerResponse,
  appId: AppId,
  conversationId: ConversationId,
): Promise<void> {
  try {
    await createBrowserConversationAdministrationService(
      appId,
    ).joinConversation({ appId, conversationId });
    sendJson(res, 200, { joined: true });
  } catch (error) {
    if (!sendApplicationError(res, error)) throw error;
  }
}

export function createBrowserConversationAdministrationService(appId: AppId) {
  const { repositories } = getRuntimeStorage();
  return new ConversationAdministrationService(
    {
      providerAccounts: repositories.providerAccounts,
      conversations: repositories.conversations,
    },
    new RuntimeSecretConversationMembershipValidator(
      createRepositoryRuntimeSecretProvider({
        appId,
        repository: repositories.capabilitySecrets,
      }),
    ),
  );
}
