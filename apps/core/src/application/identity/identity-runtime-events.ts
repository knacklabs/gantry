import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';

type RuntimeEventPublisher = (
  event: RuntimeEventPublishInput,
) => Promise<unknown> | void;

export type IdentityEventSource = 'control_api' | 'live_turn';

export type MemoryHydrationDecisionReason =
  | 'resolved'
  | 'unresolved'
  | 'retired_alias'
  | 'missing_sender'
  | 'system_sender'
  | 'resolver_error';

export async function publishIdentityResolvedEvent(
  publish: RuntimeEventPublisher | undefined,
  input: {
    appId: string;
    source: IdentityEventSource;
    provider: string;
    providerAccountId?: string | null;
    evidenceType: 'provider_user' | 'email' | 'phone' | 'web_user';
    status:
      | 'resolved'
      | 'created'
      | 'unresolved'
      | 'retired_alias'
      | 'resolver_error';
    personId?: string | null;
    verificationStatus?: 'verified' | 'unverified' | 'retired';
    memoryHydrationEligible: boolean;
    conversationJid?: string;
    threadId?: string | null;
  },
): Promise<void> {
  if (!publish) return;
  await publish({
    appId: input.appId as never,
    eventType: RUNTIME_EVENT_TYPES.IDENTITY_RESOLVED,
    actor: input.source,
    threadId: input.threadId ? (input.threadId as never) : undefined,
    payload: {
      source: input.source,
      provider: input.provider,
      ...(input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
      evidenceType: input.evidenceType,
      status: input.status,
      ...(input.personId ? { personId: input.personId } : {}),
      ...(input.verificationStatus
        ? { verificationStatus: input.verificationStatus }
        : {}),
      memoryHydrationEligible: input.memoryHydrationEligible,
      ...(input.conversationJid
        ? { conversationJid: input.conversationJid }
        : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
  });
}

export async function publishIdentityAliasLinkedEvent(
  publish: RuntimeEventPublisher | undefined,
  input: {
    appId: string;
    personId: string;
    aliasId: string;
    provider: string;
    providerAccountId?: string | null;
    verificationStatus: 'verified' | 'unverified' | 'retired';
    actor: string;
  },
): Promise<void> {
  if (!publish) return;
  await publish({
    appId: input.appId as never,
    eventType: RUNTIME_EVENT_TYPES.IDENTITY_ALIAS_LINKED,
    actor: input.actor,
    payload: {
      personId: input.personId,
      aliasId: input.aliasId,
      provider: input.provider,
      ...(input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
      verificationStatus: input.verificationStatus,
      actor: input.actor,
    },
  });
}

export async function publishIdentityAliasRetiredEvent(
  publish: RuntimeEventPublisher | undefined,
  input: {
    appId: string;
    personId: string;
    aliasId: string;
    provider: string;
    providerAccountId?: string | null;
    verificationStatus: 'verified' | 'unverified' | 'retired';
    actor: string;
  },
): Promise<void> {
  if (!publish) return;
  await publish({
    appId: input.appId as never,
    eventType: RUNTIME_EVENT_TYPES.IDENTITY_ALIAS_RETIRED,
    actor: input.actor,
    payload: {
      personId: input.personId,
      aliasId: input.aliasId,
      provider: input.provider,
      ...(input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
      verificationStatus: input.verificationStatus,
      actor: input.actor,
    },
  });
}

export async function publishMemoryHydrationDecisionEvent(
  publish: RuntimeEventPublisher | undefined,
  input: {
    appId: string;
    source: IdentityEventSource;
    conversationKind: 'dm' | 'channel';
    conversationJid: string;
    threadId?: string | null;
    provider: string;
    providerAccountId?: string | null;
    personId?: string | null;
    reason: MemoryHydrationDecisionReason;
    memoryHydrationEligible: boolean;
  },
): Promise<void> {
  if (!publish) return;
  await publish({
    appId: input.appId as never,
    eventType: RUNTIME_EVENT_TYPES.MEMORY_HYDRATION_DECISION,
    actor: input.source,
    threadId: input.threadId ? (input.threadId as never) : undefined,
    payload: {
      source: input.source,
      conversationKind: input.conversationKind,
      conversationJid: input.conversationJid,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      provider: input.provider,
      ...(input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
      ...(input.personId ? { personId: input.personId } : {}),
      reason: input.reason,
      memoryHydrationEligible: input.memoryHydrationEligible,
    },
  });
}
