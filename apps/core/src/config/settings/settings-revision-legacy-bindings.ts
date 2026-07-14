export function migrateLegacyAgentBindings(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const agents = recordOrUndefined(document.agents);
  const conversations = recordOrUndefined(document.conversations);
  if (!agents || !conversations) return document;
  if (
    !Object.values(agents).some(
      (agent) => recordOrUndefined(agent)?.bindings !== undefined,
    )
  ) {
    return document;
  }

  const next = structuredClone(document);
  const nextAgents = recordOrUndefined(next.agents);
  const nextConversations = recordOrUndefined(next.conversations);
  const providerAccounts = recordOrUndefined(next.provider_accounts) ?? {};
  if (!nextAgents || !nextConversations) return document;

  for (const [agentId, agentRaw] of Object.entries(nextAgents)) {
    const agent = recordOrUndefined(agentRaw);
    const bindings = recordOrUndefined(agent?.bindings);
    if (!agent || !bindings) continue;
    delete agent.bindings;

    for (const [bindingId, bindingRaw] of Object.entries(bindings)) {
      const binding = recordOrUndefined(bindingRaw);
      const jid = stringValue(binding?.jid);
      if (!binding || !jid) continue;
      const conversation = findLegacyBindingConversation({
        conversations: nextConversations,
        binding,
        jid,
      });
      if (!conversation) continue;
      const [conversationId, conversationRaw] = conversation;
      const conversationDoc = recordOrUndefined(conversationRaw);
      if (!conversationDoc) continue;
      const installProviderAccount = providerAccountForLegacyInstall({
        providerAccounts,
        conversation: conversationDoc,
        binding,
        agentId,
      });
      if (!installProviderAccount) continue;
      const installedAgents =
        recordOrUndefined(conversationDoc.installed_agents) ?? {};
      conversationDoc.installed_agents = installedAgents;
      installedAgents[uniqueInstallId(bindingId, installedAgents)] =
        stripUndefinedDeep({
          agent: agentId,
          provider_account: installProviderAccount,
          thread_id: stringValue(binding.thread_id ?? binding.threadId),
          status: 'active',
          added_at: stringValue(binding.added_at ?? binding.addedAt),
          memory_scope: stringValue(
            binding.memory_scope ?? binding.memoryScope,
          ),
          trigger: stringValue(binding.trigger),
          requires_trigger: binding.requires_trigger ?? binding.requiresTrigger,
          model: stringValue(binding.model),
        });
      if (!conversationDoc.provider_account) {
        conversationDoc.provider_account = installProviderAccount;
      }
      nextConversations[conversationId] = conversationDoc;
    }
  }

  return next;
}

function findLegacyBindingConversation(input: {
  conversations: Record<string, unknown>;
  binding: Record<string, unknown>;
  jid: string;
}): [string, unknown] | undefined {
  const explicitConversation = stringValue(input.binding.conversation);
  if (explicitConversation && input.conversations[explicitConversation]) {
    return [explicitConversation, input.conversations[explicitConversation]];
  }
  const explicitAccount = stringValue(
    input.binding.provider_account_id ??
      input.binding.providerAccountId ??
      input.binding.provider_account ??
      input.binding.provider_connection_id ??
      input.binding.providerConnectionId,
  );
  const jidSuffix = input.jid.includes(':')
    ? input.jid.slice(input.jid.indexOf(':') + 1)
    : input.jid;
  const candidates = Object.entries(input.conversations).filter(
    ([, conversationRaw]) => {
      const conversation = recordOrUndefined(conversationRaw);
      if (!conversation) return false;
      const externalId = stringValue(
        conversation.external_id ?? conversation.id,
      );
      return externalId === input.jid || externalId === jidSuffix;
    },
  );
  return (
    candidates.find(([, conversationRaw]) => {
      const conversation = recordOrUndefined(conversationRaw);
      return (
        explicitAccount &&
        stringValue(
          conversation?.provider_account ?? conversation?.provider_connection,
        ) === explicitAccount
      );
    }) ?? candidates[0]
  );
}

function providerAccountForLegacyInstall(input: {
  providerAccounts: Record<string, unknown>;
  conversation: Record<string, unknown>;
  binding: Record<string, unknown>;
  agentId: string;
}): string | undefined {
  const requested =
    stringValue(
      input.binding.provider_account_id ??
        input.binding.providerAccountId ??
        input.binding.provider_account ??
        input.binding.provider_connection_id ??
        input.binding.providerConnectionId,
    ) ??
    stringValue(
      input.conversation.provider_account ??
        input.conversation.provider_connection,
    );
  if (!requested) return undefined;
  const account = recordOrUndefined(input.providerAccounts[requested]);
  if (
    !account ||
    stringValue(account.agent ?? account.agent_id) === input.agentId
  ) {
    return requested;
  }
  const provider = stringValue(account.provider);
  const existing = Object.entries(input.providerAccounts).find(
    ([, candidateRaw]) => {
      const candidate = recordOrUndefined(candidateRaw);
      return (
        candidate &&
        stringValue(candidate.provider) === provider &&
        stringValue(candidate.agent ?? candidate.agent_id) === input.agentId
      );
    },
  );
  if (existing) return existing[0];
  const cloneId = `${requested}:agent:${input.agentId}`;
  input.providerAccounts[cloneId] = stripUndefinedDeep({
    ...account,
    external_identity_ref: undefined,
    agent: input.agentId,
    agent_id: undefined,
  });
  return cloneId;
}

function uniqueInstallId(
  installId: string,
  installedAgents: Record<string, unknown>,
): string {
  if (!Object.hasOwn(installedAgents, installId)) return installId;
  let index = 2;
  while (Object.hasOwn(installedAgents, `${installId}_${index}`)) index += 1;
  return `${installId}_${index}`;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      item === undefined ? [] : [[key, stripUndefinedDeep(item)]],
    ),
  );
}

function recordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
