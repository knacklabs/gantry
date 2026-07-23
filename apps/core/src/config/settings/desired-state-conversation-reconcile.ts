import type { AppId } from '../../domain/app/app.js';
import type {
  Conversation,
  ConversationId,
  ConversationThread,
} from '../../domain/conversation/conversation.js';
import { canonicalConversationThreadId } from '../../domain/conversation/conversation.js';
import type { ConversationRepository } from '../../domain/ports/repositories.js';
import type {
  ConversationInstall,
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import {
  configuredConversationKind,
  jidForConfiguredConversation,
  stripProviderPrefix,
} from './desired-state-provider-conversations.js';
import {
  agentIdForFolder,
  configuredAgentConfig,
  errorMessage,
  isValidExternalUserId,
  memorySubjectForConfiguredBinding,
  normalizeUserIds,
} from './desired-state-service-helpers.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service-types.js';
import type {
  RuntimeConfiguredConversation,
  RuntimeProviderAccountSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';

export async function reconcileDesiredConversations(input: {
  appId: AppId;
  repositories: SettingsDesiredStateRepositories;
  settings: RuntimeSettings;
  now: () => string;
  applied: string[];
  skipped: string[];
}): Promise<void> {
  if (!input.repositories.conversations || !input.repositories.providerAccounts) {
    if (Object.keys(input.settings.conversations).length > 0) {
      input.skipped.push('conversation_approvers:missing-repositories');
    }
    return;
  }
  for (const [conversationKey, conversation] of Object.entries(
    input.settings.conversations,
  )) {
    const storedConversation = await ensureDesiredConversation({
      appId: input.appId,
      repositories: input.repositories,
      key: conversationKey,
      conversation,
      providerAccounts: input.settings.providerAccounts,
      now: input.now(),
      skipped: input.skipped,
    });
    if (!storedConversation) continue;
    await rebindConfiguredConversationBindings({
      appId: input.appId,
      repositories: input.repositories,
      settings: input.settings,
      conversationKey,
      conversation,
      storedConversation,
      now: input.now(),
      skipped: input.skipped,
    });
    try {
      await replaceStoredConversationApprovers({
        appId: input.appId,
        conversations: input.repositories.conversations,
        conversation: storedConversation,
        userIds: conversation.controlApprovers,
        updatedAt: input.now(),
      });
      input.applied.push(`conversation_approvers:${conversationKey}`);
    } catch (err) {
      input.skipped.push(
        `conversation_approvers:${conversationKey}:${errorMessage(err)}`,
      );
    }
  }
}

async function ensureDesiredConversation(input: {
  appId: AppId;
  repositories: SettingsDesiredStateRepositories;
  key: string;
  conversation: RuntimeConfiguredConversation;
  providerAccounts: Record<string, RuntimeProviderAccountSettings>;
  now: string;
  skipped: string[];
}): Promise<Conversation | null> {
  const conversations = input.repositories.conversations;
  if (!conversations) return null;
  const configuredProviderAccount =
    input.conversation.providerAccount ??
    input.conversation.providerConnection;
  const connectionSettings =
    input.providerAccounts[configuredProviderAccount];
  if (!connectionSettings) {
    input.skipped.push(
      `conversation:${input.key}:missing-provider-connection`,
    );
    return null;
  }
  const jid = jidForConfiguredConversation(
    input.conversation,
    input.providerAccounts,
  );
  const externalConversationId = stripProviderPrefix(jid);

  const providerId = connectionSettings.provider as ProviderId;
  const providerAccountId = configuredProviderAccount as ProviderAccountId;
  const existing = await findConfiguredConversation({
    appId: input.appId,
    conversations,
    providerId,
    providerAccountId,
    externalConversationId,
  });
  const kind = configuredConversationKind(input.conversation.kind);
  if (existing) {
    if (
      existing.providerAccountId === providerAccountId &&
      existing.externalRef?.value === externalConversationId &&
      existing.kind === kind &&
      existing.title === input.conversation.displayName &&
      existing.status === 'active'
    ) {
      return existing;
    }
    const reconciled: Conversation = {
      ...existing,
      providerAccountId,
      externalRef: {
        kind: 'conversation',
        value: externalConversationId,
      },
      kind,
      title: input.conversation.displayName,
      status: 'active',
      updatedAt: input.now,
    };
    await conversations.saveConversation(reconciled);
    return reconciled;
  }

  const conversation: Conversation = {
    id: `conversation:${providerAccountId}:${jid}` as ConversationId,
    appId: input.appId,
    providerAccountId,
    externalRef: {
      kind: 'conversation',
      value: externalConversationId,
    },
    kind,
    title: input.conversation.displayName,
    status: 'active',
    createdAt: input.now,
    updatedAt: input.now,
  };
  await conversations.saveConversation(conversation);
  return conversation;
}

async function rebindConfiguredConversationBindings(input: {
  appId: AppId;
  repositories: SettingsDesiredStateRepositories;
  settings: RuntimeSettings;
  conversationKey: string;
  conversation: RuntimeConfiguredConversation;
  storedConversation: Conversation;
  now: string;
  skipped: string[];
}): Promise<void> {
  const providerAccounts = input.repositories.providerAccounts;
  if (!providerAccounts) return;
  const desiredInstallIds = new Set<ConversationInstall['id']>();
  const installConversationIds = new Set<Conversation['id']>([
    input.storedConversation.id,
  ]);
  for (const [bindingKey, binding] of Object.entries(input.settings.bindings)) {
    if (binding.conversation !== input.conversationKey) continue;
    const agent = input.settings.agents[binding.agent];
    if (!agent) continue;
    const agentId = agentIdForFolder(binding.agent);
    const install =
      input.conversation.installedAgents?.[binding.installKey ?? ''];
    const installProviderAccountId =
      install?.providerAccountId ?? input.storedConversation.providerAccountId;
    const installConversation =
      installProviderAccountId === input.storedConversation.providerAccountId
        ? input.storedConversation
        : await ensureDesiredConversation({
            appId: input.appId,
            repositories: input.repositories,
            key: `${input.conversationKey}:${installProviderAccountId}`,
            conversation: {
              ...input.conversation,
              providerAccount: installProviderAccountId,
              providerConnection: installProviderAccountId,
            },
            providerAccounts: input.settings.providerAccounts,
            now: input.now,
            skipped: input.skipped,
          });
    if (!installConversation) continue;
    if (installConversation.id !== input.storedConversation.id) {
      await replaceStoredConversationApprovers({
        appId: input.appId,
        conversations: input.repositories.conversations,
        conversation: installConversation,
        participantSourceConversation: input.storedConversation,
        userIds: input.conversation.controlApprovers,
        updatedAt: input.now,
      });
    }
    const threadId = binding.threadId
      ? await ensureDesiredConversationThread({
          appId: input.appId,
          conversations: input.repositories.conversations,
          conversation: installConversation,
          publicThreadId: binding.threadId,
          now: input.now,
        })
      : undefined;
    const installId = `agent-conversation-binding:${encodeURIComponent(
      binding.agent,
    )}:${encodeURIComponent(bindingKey)}` as ConversationInstall['id'];
    desiredInstallIds.add(installId);
    installConversationIds.add(installConversation.id);
    await providerAccounts.saveConversationInstall({
      id: installId,
      appId: input.appId,
      agentId,
      providerAccountId: installProviderAccountId as ProviderAccountId,
      conversationId: installConversation.id,
      ...(threadId ? { threadId } : {}),
      displayName: input.conversation.displayName || agent.name,
      status: 'active',
      senderPolicy: 'provider_native',
      controlPolicy: 'conversation_approvers',
      memoryScope: binding.memoryScope,
      memorySubject: {
        ...memorySubjectForConfiguredBinding({
          appId: input.appId,
          agentId,
          memoryScope: binding.memoryScope,
          conversation: input.conversation,
          conversationId: installConversation.id,
        }),
        route: {
          configuredConversationId: input.conversationKey,
          trigger: binding.trigger,
          requiresTrigger: binding.requiresTrigger,
          agentConfig: configuredAgentConfig(binding),
        },
      },
      permissionPolicyIds: [],
      createdAt: binding.addedAt || input.now,
      updatedAt: input.now,
    } satisfies ConversationInstall);
  }
  for (const install of Object.values(
    input.conversation.installedAgents ?? {},
  )) {
    if (install.status !== 'disabled') continue;
    const installProviderAccountId =
      install.providerAccountId ?? input.storedConversation.providerAccountId;
    const installConversation =
      installProviderAccountId === input.storedConversation.providerAccountId
        ? input.storedConversation
        : await ensureDesiredConversation({
            appId: input.appId,
            repositories: input.repositories,
            key: `${input.conversationKey}:${installProviderAccountId}`,
            conversation: {
              ...input.conversation,
              providerAccount: installProviderAccountId,
              providerConnection: installProviderAccountId,
            },
            providerAccounts: input.settings.providerAccounts,
            now: input.now,
            skipped: input.skipped,
          });
    if (!installConversation) continue;
    installConversationIds.add(installConversation.id);
    const threadId = canonicalConversationThreadId({
      conversation: installConversation,
      threadId: install.threadId,
    });
    await providerAccounts.disableConversationInstall({
      appId: input.appId,
      agentId: agentIdForFolder(install.agentId),
      conversationId: installConversation.id,
      ...(threadId ? { threadId } : {}),
      updatedAt: input.now,
    });
  }
  if (!input.settings.desiredState.authoritative) return;
  for (const conversationId of installConversationIds) {
    const storedInstalls =
      await providerAccounts.listConversationInstallsByConversation({
        appId: input.appId,
        conversationId,
      });
    for (const install of storedInstalls) {
      if (install.status !== 'active') continue;
      if (desiredInstallIds.has(install.id)) continue;
      await providerAccounts.disableConversationInstall({
        appId: input.appId,
        agentId: install.agentId,
        conversationId: install.conversationId,
        ...(install.threadId ? { threadId: install.threadId } : {}),
        updatedAt: input.now,
      });
    }
  }
}

async function ensureDesiredConversationThread(input: {
  appId: AppId;
  conversations: ConversationRepository | undefined;
  conversation: Conversation;
  publicThreadId: string;
  now: string;
}): Promise<ConversationThread['id'] | undefined> {
  const threadId = canonicalConversationThreadId({
    conversation: input.conversation,
    threadId: input.publicThreadId,
  });
  if (!threadId) return undefined;
  await input.conversations?.saveThread({
    id: threadId,
    appId: input.appId,
    conversationId: input.conversation.id,
    externalRef: {
      kind: 'conversation_thread',
      value: input.publicThreadId,
    },
    status: 'active',
    createdAt: input.now,
    updatedAt: input.now,
  });
  return threadId;
}

async function replaceStoredConversationApprovers(input: {
  appId: AppId;
  conversations: ConversationRepository | undefined;
  conversation: Conversation;
  participantSourceConversation?: Conversation;
  userIds: string[];
  updatedAt: string;
}): Promise<void> {
  if (!input.conversations) return;
  const userIds = normalizeUserIds(input.userIds);
  const invalidShape = userIds.filter((id) => !isValidExternalUserId(id));
  if (invalidShape.length > 0) {
    throw new Error(
      `Invalid control approver user ids: ${invalidShape.join(', ')}`,
    );
  }
  if (userIds.length > 0) {
    const knownMembers = new Set(
      await input.conversations.listParticipantExternalUserIds(
        input.participantSourceConversation?.id ?? input.conversation.id,
      ),
    );
    const invalidUserIds = userIds.filter((id) => !knownMembers.has(id));
    if (invalidUserIds.length > 0) {
      throw new Error(
        [
          'Control approvers must be members of the conversation.',
          `Invalid: ${invalidUserIds.join(', ')}`,
          knownMembers.size === 0
            ? 'No conversation participant records are available.'
            : undefined,
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }
  await input.conversations.replaceConversationApprovers({
    appId: input.appId,
    conversationId: input.conversation.id,
    externalUserIds: userIds,
    updatedAt: input.updatedAt,
  });
}

function findConfiguredConversation(input: {
  appId: AppId;
  conversations: ConversationRepository;
  providerId: ProviderId;
  providerAccountId: ProviderAccountId;
  externalConversationId: string;
}): Promise<Conversation | null> {
  return input.conversations.getConversationByExternalRef({
    appId: input.appId,
    providerId: input.providerId,
    providerAccountId: input.providerAccountId,
    externalConversationId: input.externalConversationId,
  });
}
