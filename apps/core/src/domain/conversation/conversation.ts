import type { AppId } from '../app/app.js';
import type { ProviderAccountId } from '../provider/provider.js';
import type { BrandedId, ExternalRef } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type ConversationId = BrandedId<'ConversationId'>;
export type ConversationThreadId = BrandedId<'ConversationThreadId'>;
export type ExternalConversationId = BrandedId<'ExternalConversationId'>;
export type UserId = BrandedId<'UserId'>;

export interface Conversation {
  id: ConversationId;
  appId: AppId;
  providerAccountId: ProviderAccountId;
  externalRef?: ExternalRef<'conversation'>;
  kind: 'direct' | 'group' | 'channel' | 'service' | 'web';
  title?: string;
  status: 'active' | 'archived' | 'disabled';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ConversationThread {
  id: ConversationThreadId;
  appId: AppId;
  conversationId: ConversationId;
  externalRef?: ExternalRef<'conversation_thread'>;
  title?: string;
  status: 'active' | 'archived';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export function canonicalConversationThreadId(input: {
  conversation: Pick<Conversation, 'id' | 'providerAccountId' | 'externalRef'>;
  threadId?: string | null;
}): ConversationThreadId | undefined {
  const threadId = input.threadId?.trim();
  if (!threadId) return undefined;
  const accountPrefix = `thread:${input.conversation.providerAccountId}:`;
  if (threadId.startsWith(accountPrefix)) {
    return threadId as ConversationThreadId;
  }
  return `${accountPrefix}${conversationJidForThreadId(input.conversation)}:${threadId}` as ConversationThreadId;
}

function conversationJidForThreadId(
  conversation: Pick<Conversation, 'id' | 'providerAccountId' | 'externalRef'>,
): string {
  const scopedPrefix = `conversation:${conversation.providerAccountId}:`;
  const id = String(conversation.id);
  if (id.startsWith(scopedPrefix)) return id.slice(scopedPrefix.length);
  if (id.startsWith('conversation:')) return id.slice('conversation:'.length);
  return String(conversation.externalRef?.value ?? id);
}
