import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import {
  isRuntimeEventConversationFkId,
  isRuntimeEventThreadFkId,
} from '../../domain/events/runtime-event-conversation.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { logger } from '../../infrastructure/logging/logger.js';

type RuntimeEventPublisher = (
  event: RuntimeEventPublishInput,
) => Promise<unknown> | void;

type IdentityAliasEventInput = {
  appId: string;
  personId: string;
  aliasId: string;
  provider: string;
  providerAccountId?: string | null;
  verificationStatus: 'verified' | 'unverified' | 'retired';
  actor: string;
};

export type IdentityEventSource = 'control_api' | 'live_turn';

export type MemoryHydrationDecisionReason =
  | 'resolved'
  | 'unresolved'
  | 'retired_alias'
  | 'missing_sender'
  | 'system_sender'
  | 'resolver_error';

function eventSafePersonId(personId: string | null | undefined) {
  if (!personId || /^user:[^:]+:[^:]+:.+$/.test(personId)) return undefined;
  return personId;
}

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
  try {
    await publish(identityResolvedEvent(input));
  } catch (error) {
    if (input.source !== 'live_turn') throw error;
    logger.warn(
      { err: error, appId: input.appId },
      'Live identity audit event was not persisted',
    );
  }
}

export function identityResolvedEvent(input: {
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
}): RuntimeEventPublishInput {
  const personId = eventSafePersonId(input.personId);
  return {
    appId: input.appId as never,
    ...(isRuntimeEventConversationFkId(input.conversationJid)
      ? { conversationId: input.conversationJid }
      : {}),
    ...(isRuntimeEventThreadFkId(input.threadId ?? undefined)
      ? { threadId: input.threadId as never }
      : {}),
    eventType: RUNTIME_EVENT_TYPES.IDENTITY_RESOLVED,
    actor: input.source,
    payload: {
      source: input.source,
      provider: input.provider,
      ...(input.providerAccountId
        ? { providerConnectionId: input.providerAccountId }
        : {}),
      evidenceType: input.evidenceType,
      status: input.status,
      ...(personId ? { personId } : {}),
      ...(input.verificationStatus
        ? { verificationStatus: input.verificationStatus }
        : {}),
      memoryHydrationEligible: input.memoryHydrationEligible,
      ...(input.conversationJid
        ? { conversationJid: input.conversationJid }
        : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
  };
}

export async function publishIdentityAliasLinkedEvent(
  publish: RuntimeEventPublisher | undefined,
  input: IdentityAliasEventInput,
): Promise<void> {
  if (!publish) return;
  await publish(identityAliasLinkedEvent(input));
}

export function identityAliasLinkedEvent(
  input: IdentityAliasEventInput,
): RuntimeEventPublishInput {
  return {
    appId: input.appId as never,
    eventType: RUNTIME_EVENT_TYPES.IDENTITY_ALIAS_LINKED,
    actor: input.actor,
    payload: {
      personId: input.personId,
      aliasId: input.aliasId,
      provider: input.provider,
      ...(input.providerAccountId
        ? { providerConnectionId: input.providerAccountId }
        : {}),
      verificationStatus: input.verificationStatus,
      actor: input.actor,
    },
  };
}

export async function publishIdentityAliasRetiredEvent(
  publish: RuntimeEventPublisher | undefined,
  input: IdentityAliasEventInput,
): Promise<void> {
  if (!publish) return;
  await publish(identityAliasRetiredEvent(input));
}

export function identityAliasRetiredEvent(
  input: IdentityAliasEventInput,
): RuntimeEventPublishInput {
  return {
    appId: input.appId as never,
    eventType: RUNTIME_EVENT_TYPES.IDENTITY_ALIAS_RETIRED,
    actor: input.actor,
    payload: {
      personId: input.personId,
      aliasId: input.aliasId,
      provider: input.provider,
      ...(input.providerAccountId
        ? { providerConnectionId: input.providerAccountId }
        : {}),
      verificationStatus: input.verificationStatus,
      actor: input.actor,
    },
  };
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
  const personId = eventSafePersonId(input.personId);
  try {
    await publish({
      appId: input.appId as never,
      ...(isRuntimeEventConversationFkId(input.conversationJid)
        ? { conversationId: input.conversationJid }
        : {}),
      ...(isRuntimeEventThreadFkId(input.threadId ?? undefined)
        ? { threadId: input.threadId as never }
        : {}),
      eventType: RUNTIME_EVENT_TYPES.MEMORY_HYDRATION_DECISION,
      actor: input.source,
      payload: {
        source: input.source,
        conversationKind: input.conversationKind,
        conversationJid: input.conversationJid,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        provider: input.provider,
        ...(input.providerAccountId
          ? { providerConnectionId: input.providerAccountId }
          : {}),
        ...(personId ? { personId } : {}),
        reason: input.reason,
        memoryHydrationEligible: input.memoryHydrationEligible,
      },
    });
  } catch (error) {
    if (input.source !== 'live_turn') throw error;
    logger.warn(
      { err: error, appId: input.appId },
      'Live hydration audit event was not persisted',
    );
  }
}
