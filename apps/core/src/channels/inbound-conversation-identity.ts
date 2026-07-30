import type { ConversationRoute, NewMessage } from '../domain/types.js';
import { findConversationRoutesForChat } from '../shared/thread-queue-key.js';

export interface InboundConversationIdentity {
  needsStandaloneMetadataWrite: boolean;
  messageIdentity: Pick<NewMessage, 'name' | 'isGroup'>;
}

/**
 * One rule, shared by every provider ingress that pairs a metadata write with a
 * message write (LAT-4A, decision 0085).
 *
 * Before LAT-4A each ingress wrote conversation metadata AND then persisted a
 * message whose own `ensureConversation` redid the same seven-table graph write
 * — nine duplicate SQL statements per inbound message. Carrying name/isGroup on
 * the message lets the envelope's single `ensureConversation` do that work once.
 *
 * The metadata write survives ONLY where no message follows. Note this is
 * `!hasRegisteredRoute`, NOT `!hasRegisteredRoute && isGroup`: `onMessage`
 * rejects an unregistered DIRECT chat before persisting anything
 * (channel-persistence-handlers.ts), so no envelope follows for those either,
 * and narrowing the rule to groups deletes their conversation row outright.
 * That was measured — `ensureConversation` dropped to zero calls on that path.
 */
export function resolveInboundConversationIdentity(input: {
  hasRegisteredRoute: boolean;
  name: NewMessage['name'];
  isGroup: boolean;
}): InboundConversationIdentity {
  return {
    needsStandaloneMetadataWrite: !input.hasRegisteredRoute,
    messageIdentity: { name: input.name, isGroup: input.isGroup },
  };
}

/**
 * Same rule, resolving the route lookup for you. Preferred at ingress call
 * sites so the `findConversationRoutesForChat(...).length > 0` boilerplate lives
 * in one place instead of once per provider.
 */
export function resolveInboundConversationIdentityForChat(input: {
  conversationRoutes: Record<string, ConversationRoute>;
  chatJid: string;
  threadId?: string | null;
  providerAccountId?: string;
  name: NewMessage['name'];
  isGroup: boolean;
}): InboundConversationIdentity {
  return resolveInboundConversationIdentity({
    hasRegisteredRoute:
      findConversationRoutesForChat(
        input.conversationRoutes,
        input.chatJid,
        input.threadId ?? undefined,
        input.providerAccountId,
      ).length > 0,
    name: input.name,
    isGroup: input.isGroup,
  });
}

/**
 * The rule and its consequence together: writes standalone metadata when (and
 * only when) no message envelope will follow, and returns the identity fields to
 * spread onto the outgoing message. Ingress call sites should prefer this — it
 * keeps the "skip the write, carry the fields" pair from drifting apart in one
 * provider while staying correct in the others.
 */
export async function applyInboundConversationIdentity(input: {
  conversationRoutes: Record<string, ConversationRoute>;
  chatJid: string;
  threadId?: string | null;
  providerAccountId?: string;
  name: NewMessage['name'];
  isGroup: boolean;
  writeMetadata: () => Promise<void>;
}): Promise<Pick<NewMessage, 'name' | 'isGroup'>> {
  const identity = resolveInboundConversationIdentityForChat(input);
  if (identity.needsStandaloneMetadataWrite) await input.writeMetadata();
  return identity.messageIdentity;
}
