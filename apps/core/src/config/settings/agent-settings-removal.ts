import type { RuntimeSettings } from './runtime-settings-types.js';

/** Removes an agent and every desired-state reference that depends on it. */
export function removeAgentFromRuntimeSettings(
  settings: RuntimeSettings,
  folder: string,
): number {
  delete settings.agents[folder];
  let providerAccountsPruned = 0;
  for (const [accountId, account] of Object.entries(
    settings.providerAccounts,
  )) {
    if (account.agentId !== folder) continue;
    for (const [conversationId, conversation] of Object.entries(
      settings.conversations,
    )) {
      for (const [installKey, install] of Object.entries(
        conversation.installedAgents,
      )) {
        if (
          install.providerAccountId !== accountId &&
          install.agentId !== folder
        ) {
          continue;
        }
        delete conversation.installedAgents[installKey];
      }
      const survivingInstalls = Object.values(conversation.installedAgents);
      if (survivingInstalls.length === 0) {
        delete settings.conversations[conversationId];
        continue;
      }
      if (conversation.providerAccount === accountId) {
        const replacement = survivingInstalls.find(
          (install) =>
            install.providerAccountId &&
            install.providerAccountId !== accountId,
        )?.providerAccountId;
        if (!replacement) {
          throw new Error(
            `cannot remove ${folder}: conversation ${conversationId} still hosts ${survivingInstalls.length} agent(s) but has no other provider account to own it`,
          );
        }
        conversation.providerAccount = replacement;
      }
    }
    delete settings.providerAccounts[accountId];
    providerAccountsPruned += 1;
  }
  return providerAccountsPruned;
}
