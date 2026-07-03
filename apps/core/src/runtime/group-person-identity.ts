import type { NewMessage } from '../domain/types.js';
import type { ConversationRoute } from '../domain/types.js';
import {
  publishIdentityResolvedEvent,
  publishMemoryHydrationDecisionEvent,
} from '../application/identity/identity-runtime-events.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { GroupProcessingDeps } from './group-processing-types.js';

export function createCanonicalMemoryPersonResolver(input: {
  resolvePersonIdentity?: GroupProcessingDeps['resolvePersonIdentity'];
  publishRuntimeEvent?: GroupProcessingDeps['publishRuntimeEvent'];
  appId: string;
  rawUserId?: string;
  defaultScope: 'user' | 'group';
  conversationKind: 'dm' | 'channel';
  messages: NewMessage[];
  chatJid: string;
  threadId?: string | null;
  providerAccountId?: string;
  identityEvidenceType?: 'provider_user' | 'web_user';
  systemSenderIds?: readonly string[];
}): () => Promise<string | undefined> {
  let resolved: Promise<string | undefined> | null = null;
  return () => {
    resolved ??= resolveCanonicalMemoryPersonId(input);
    return resolved;
  };
}

export function createGroupProcessingPersonResolver(input: {
  deps: Pick<
    GroupProcessingDeps,
    'resolvePersonIdentity' | 'publishRuntimeEvent'
  >;
  appId: string;
  rawUserId?: string;
  defaultScope: 'user' | 'group';
  group: Pick<
    ConversationRoute,
    | 'conversationKind'
    | 'providerAccountId'
    | 'senderIdentityEvidenceType'
    | 'systemSenderIds'
  >;
  messages: NewMessage[];
  chatJid: string;
  threadId?: string | null;
}): () => Promise<string | undefined> {
  return createCanonicalMemoryPersonResolver({
    resolvePersonIdentity: input.deps.resolvePersonIdentity,
    publishRuntimeEvent: input.deps.publishRuntimeEvent,
    appId: input.appId,
    rawUserId: input.rawUserId,
    defaultScope: input.defaultScope,
    conversationKind: input.group.conversationKind ?? 'channel',
    messages: input.messages,
    chatJid: input.chatJid,
    threadId: input.threadId,
    providerAccountId: input.group.providerAccountId,
    identityEvidenceType: input.group.senderIdentityEvidenceType,
    systemSenderIds: input.group.systemSenderIds,
  });
}

export async function resolveCanonicalMemoryPersonId(input: {
  resolvePersonIdentity?: GroupProcessingDeps['resolvePersonIdentity'];
  publishRuntimeEvent?: GroupProcessingDeps['publishRuntimeEvent'];
  appId: string;
  rawUserId?: string;
  defaultScope: 'user' | 'group';
  conversationKind: 'dm' | 'channel';
  messages: NewMessage[];
  chatJid: string;
  threadId?: string | null;
  providerAccountId?: string;
  identityEvidenceType?: 'provider_user' | 'web_user';
  systemSenderIds?: readonly string[];
}): Promise<string | undefined> {
  const externalUserId = input.rawUserId?.trim();
  const message = externalUserId
    ? [...input.messages]
        .reverse()
        .find((item) => item.sender === externalUserId)
    : undefined;
  const provider = (message?.provider || providerFromJid(input.chatJid)).trim();
  const evidenceType = input.identityEvidenceType ?? 'provider_user';
  const systemSenderIds = new Set(input.systemSenderIds ?? []);
  if (!externalUserId) {
    await publishMemoryHydrationDecisionEvent(input.publishRuntimeEvent, {
      appId: input.appId,
      source: 'live_turn',
      conversationKind: input.conversationKind,
      conversationJid: input.chatJid,
      threadId: input.threadId,
      provider,
      providerAccountId: input.providerAccountId,
      reason: 'missing_sender',
      memoryHydrationEligible: false,
    });
    return undefined;
  }
  if (systemSenderIds.has(externalUserId)) {
    await publishMemoryHydrationDecisionEvent(input.publishRuntimeEvent, {
      appId: input.appId,
      source: 'live_turn',
      conversationKind: input.conversationKind,
      conversationJid: input.chatJid,
      threadId: input.threadId,
      provider,
      providerAccountId: input.providerAccountId,
      reason: 'system_sender',
      memoryHydrationEligible: false,
    });
    return undefined;
  }
  if (!input.resolvePersonIdentity || !provider) {
    await publishMemoryHydrationDecisionEvent(input.publishRuntimeEvent, {
      appId: input.appId,
      source: 'live_turn',
      conversationKind: input.conversationKind,
      conversationJid: input.chatJid,
      threadId: input.threadId,
      provider,
      providerAccountId: input.providerAccountId,
      reason: 'resolver_error',
      memoryHydrationEligible: false,
    });
    return undefined;
  }
  try {
    const resolved = await input.resolvePersonIdentity({
      appId: input.appId,
      provider,
      providerAccountId: input.providerAccountId,
      externalUserId,
      displayName: message?.sender_name || externalUserId,
      evidenceType,
      createIfMissing: true,
    });
    await publishIdentityResolvedEvent(input.publishRuntimeEvent, {
      appId: input.appId,
      source: 'live_turn',
      provider,
      providerAccountId: input.providerAccountId,
      evidenceType,
      status: resolved.status,
      personId: resolved.personId,
      verificationStatus: resolved.verificationStatus,
      memoryHydrationEligible: resolved.memoryHydrationEligible,
      conversationJid: input.chatJid,
      threadId: input.threadId,
    });
    const canHydratePersonalMemory =
      input.defaultScope === 'user' && resolved.memoryHydrationEligible;
    const personId =
      canHydratePersonalMemory && resolved.personId
        ? resolved.personId
        : undefined;
    await publishMemoryHydrationDecisionEvent(input.publishRuntimeEvent, {
      appId: input.appId,
      source: 'live_turn',
      conversationKind: input.conversationKind,
      conversationJid: input.chatJid,
      threadId: input.threadId,
      provider,
      providerAccountId: input.providerAccountId,
      personId,
      reason: resolved.personId ? 'resolved' : 'unresolved',
      memoryHydrationEligible: Boolean(personId),
    });
    return personId;
  } catch (error) {
    const retiredAlias =
      error instanceof Error &&
      /retired and cannot resolve active personal memory/i.test(error.message);
    await publishIdentityResolvedEvent(input.publishRuntimeEvent, {
      appId: input.appId,
      source: 'live_turn',
      provider,
      providerAccountId: input.providerAccountId,
      evidenceType,
      status: retiredAlias ? 'retired_alias' : 'resolver_error',
      verificationStatus: retiredAlias ? 'retired' : undefined,
      memoryHydrationEligible: false,
      conversationJid: input.chatJid,
      threadId: input.threadId,
    });
    await publishMemoryHydrationDecisionEvent(input.publishRuntimeEvent, {
      appId: input.appId,
      source: 'live_turn',
      conversationKind: input.conversationKind,
      conversationJid: input.chatJid,
      threadId: input.threadId,
      provider,
      providerAccountId: input.providerAccountId,
      reason: retiredAlias ? 'retired_alias' : 'resolver_error',
      memoryHydrationEligible: false,
    });
    logger.warn(
      {
        err: error,
        appId: input.appId,
        provider,
      },
      'Skipped personal memory hydration because sender identity did not resolve',
    );
    return undefined;
  }
}

function providerFromJid(chatJid: string): string {
  const index = chatJid.indexOf(':');
  return index > 0 ? chatJid.slice(0, index) : 'app';
}
