import type { parseConfiguredAgents } from './runtime-settings-agents-parser.js';
import type {
  RuntimeConfiguredBinding,
  RuntimeConfiguredConversation,
  RuntimeProviderAccountSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';

export function deriveAgentBindingsFromDesiredState(input: {
  agents: ReturnType<typeof parseConfiguredAgents>;
  providerAccounts: Record<string, RuntimeProviderAccountSettings>;
  conversations: Record<string, RuntimeConfiguredConversation>;
  bindings: Record<string, RuntimeConfiguredBinding>;
  jidForConversation(conversation: RuntimeConfiguredConversation): string;
}): ReturnType<typeof parseConfiguredAgents> {
  const agents = Object.fromEntries(
    Object.entries(input.agents).map(([agentId, agent]) => [
      agentId,
      { ...agent, bindings: { ...agent.bindings } },
    ]),
  );

  for (const [bindingId, binding] of Object.entries(input.bindings)) {
    const agent = agents[binding.agent];
    const conversation = input.conversations[binding.conversation];
    if (!agent || !conversation) continue;
    const connection =
      input.providerAccounts[conversation.providerAccount] ??
      input.providerAccounts[conversation.providerConnection ?? ''];
    const install =
      conversation.installedAgents[binding.installKey ?? ''] ??
      Object.values(conversation.installedAgents).find(
        (candidate) =>
          candidate.agentId === binding.agent &&
          (candidate.threadId ?? '') === (binding.threadId ?? ''),
      );
    agent.bindings[bindingId] = {
      jid: input.jidForConversation(conversation),
      threadId: binding.threadId,
      provider: connection?.provider,
      providerAccountId:
        install?.providerAccountId ??
        conversation.providerAccount ??
        conversation.providerConnection,
      name: conversation.displayName,
      trigger: binding.trigger,
      addedAt: binding.addedAt,
      requiresTrigger: binding.requiresTrigger,
      model: binding.model ?? agent.model,
      permissionMode: binding.permissionMode,
    };
  }

  return agents;
}

export function deriveBindingsFromConversationInstalls(
  conversations: Record<string, RuntimeConfiguredConversation>,
): Record<string, RuntimeConfiguredBinding> {
  const bindings: Record<string, RuntimeConfiguredBinding> = {};
  for (const [conversationId, conversation] of Object.entries(conversations)) {
    for (const [installId, install] of Object.entries(
      conversation.installedAgents,
    )) {
      if (install.status !== 'active') continue;
      const bindingId = derivedInstallKey(installId, conversationId, install);
      bindings[bindingId] = {
        agent: install.agentId,
        conversation: conversationId,
        installKey: installId,
        threadId: install.threadId,
        trigger: install.trigger ?? '',
        addedAt: install.addedAt,
        requiresTrigger: install.requiresTrigger ?? false,
        memoryScope: install.memoryScope,
        model: install.model,
        permissionMode: install.permissionMode,
      };
    }
  }
  return bindings;
}

export function flattenConversationInstalls(
  conversations: Record<string, RuntimeConfiguredConversation>,
): RuntimeSettings['conversationInstalls'] {
  const installs: RuntimeSettings['conversationInstalls'] = {};
  for (const [conversationId, conversation] of Object.entries(conversations)) {
    for (const [installId, install] of Object.entries(
      conversation.installedAgents,
    )) {
      installs[derivedInstallKey(installId, conversationId, install)] = {
        ...install,
        conversationId,
      };
    }
  }
  return installs;
}

function derivedInstallKey(
  installId: string,
  conversationId: string,
  install: RuntimeConfiguredConversation['installedAgents'][string],
): string {
  const scope =
    install.threadId ?? (installId === install.agentId ? '' : installId);
  return scope
    ? `${install.agentId}_${conversationId}_${scope}`
    : `${install.agentId}_${conversationId}`;
}
