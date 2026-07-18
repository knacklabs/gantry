import { createHash } from 'node:crypto';

import type { Conversation } from '../../domain/conversation/conversation.js';
import type { RuntimeSettings } from './runtime-settings-types.js';

export function applyConversationInstallToSettings(input: {
  settings: RuntimeSettings;
  conversation: Pick<Conversation, 'id' | 'externalRef' | 'kind' | 'title'>;
  providerAccountId: string;
  agentFolder: string;
  controlApprovers: readonly string[];
  now: string;
}): string {
  const { settings, conversation, providerAccountId, agentFolder } = input;
  const conversationKey = configuredConversationKey(
    settings,
    conversation,
    providerAccountId,
  );
  const existing = settings.conversations[conversationKey];
  const externalId = conversationExternalId(conversation, providerAccountId);
  const controlApprovers = input.controlApprovers.length
    ? [...new Set(input.controlApprovers.map((value) => value.trim()))].filter(
        Boolean,
      )
    : (existing?.controlApprovers ?? []);

  settings.conversations[conversationKey] = {
    providerConnection: providerAccountId,
    providerAccount: providerAccountId,
    externalId,
    kind: conversation.kind === 'direct' ? 'dm' : conversation.kind,
    displayName: conversation.title || existing?.displayName || conversationKey,
    senderPolicy:
      existing?.senderPolicy ?? ({ allow: '*', mode: 'trigger' } as never),
    controlApprovers,
    installedAgents: {
      ...(existing?.installedAgents ?? {}),
      [agentFolder]: {
        agentId: agentFolder,
        providerAccountId,
        status: 'active',
        addedAt: input.now,
        memoryScope: 'conversation',
        trigger: `@${settings.agents[agentFolder]?.name || agentFolder}`,
        requiresTrigger: conversation.kind !== 'direct',
      },
    },
  };
  return conversationKey;
}

function conversationExternalId(
  conversation: Pick<Conversation, 'id' | 'externalRef'>,
  providerAccountId: string,
): string {
  if (conversation.externalRef?.value) return conversation.externalRef.value;
  // Account-qualified ids (conversation:<account>:<jid>) must fall back to
  // the provider jid, not '<account>:<jid>'.
  const bare = String(conversation.id).replace(/^conversation:/, '');
  const accountPrefix = `${providerAccountId}:`;
  return bare.startsWith(accountPrefix)
    ? bare.slice(accountPrefix.length)
    : bare;
}

function configuredConversationKey(
  settings: Pick<RuntimeSettings, 'conversations'>,
  conversation: Pick<Conversation, 'id' | 'externalRef'>,
  providerAccountId: string,
): string {
  const externalId = conversationExternalId(conversation, providerAccountId);
  const existing = Object.entries(settings.conversations).find(
    ([, configured]) =>
      configured.externalId === externalId &&
      (configured.providerAccount ?? configured.providerConnection) ===
        providerAccountId,
  );
  if (existing) return existing[0];
  const raw = `${providerAccountId}_${externalId}`;
  const base =
    raw
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^[^A-Za-z0-9]+/, '')
      .replace(/_+/g, '_')
      .slice(0, 80)
      .replace(/[_-]+$/, '') || 'conversation';
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${base}_${hash}`;
}
