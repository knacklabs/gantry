import type { AppId } from '../../domain/app/app.js';
import type { ConversationRepository } from '../../domain/ports/repositories.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import {
  jidForConfiguredConversation,
  stripProviderPrefix,
} from './desired-state-provider-conversations.js';
import type { RuntimeSettings } from './runtime-settings-types.js';

export type ObserverOwnerResolutionFailure =
  | 'owner_not_configured'
  | 'owner_conversation_not_found'
  | 'owner_conversation_not_direct'
  | 'owner_recipient_not_approver'
  | 'owner_recipient_not_verified'
  | 'owner_provider_account_not_found'
  | 'owner_provider_account_disabled'
  | 'owner_provider_disabled';

export interface ObserverOwnerRoute {
  recipient: string;
  conversation: string;
  conversationJid: string;
  providerAccountId: string;
  providerId: string;
  externalConversationId: string;
}

export type ObserverOwnerResolution =
  | { ok: true; owner: ObserverOwnerRoute }
  | { ok: false; reason: ObserverOwnerResolutionFailure };

export type ObserverActivationStatus =
  | {
      state: 'disabled';
      enabled: false;
      active: false;
      reason: 'observer_disabled';
      message: string;
    }
  | {
      state: 'configuration_required';
      enabled: true;
      active: false;
      reason: ObserverOwnerResolutionFailure;
      message: string;
    }
  | {
      state: 'evidence_accumulating';
      enabled: true;
      active: false;
      reason:
        | 'dreaming_disabled'
        | 'memory_disabled'
        | 'embeddings_unavailable';
      message: string;
      owner: ObserverOwnerRoute;
    }
  | {
      state: 'active';
      enabled: true;
      active: true;
      message: string;
      owner: ObserverOwnerRoute;
    };

export function resolveObserverOwnerRoute(
  settings: RuntimeSettings,
): ObserverOwnerResolution {
  const owner = settings.observer.owner;
  if (!owner) return { ok: false, reason: 'owner_not_configured' };
  const conversation = settings.conversations[owner.conversation];
  if (!conversation) {
    return { ok: false, reason: 'owner_conversation_not_found' };
  }
  if (conversation.kind !== 'dm' && conversation.kind !== 'direct') {
    return { ok: false, reason: 'owner_conversation_not_direct' };
  }
  if (!conversation.controlApprovers.includes(owner.recipient)) {
    return { ok: false, reason: 'owner_recipient_not_approver' };
  }
  const providerAccountId =
    conversation.providerAccount ?? conversation.providerConnection ?? '';
  const providerAccount = settings.providerAccounts[providerAccountId];
  if (!providerAccount) {
    return { ok: false, reason: 'owner_provider_account_not_found' };
  }
  if (providerAccount.status === 'disabled') {
    return { ok: false, reason: 'owner_provider_account_disabled' };
  }
  if (settings.providers[providerAccount.provider]?.enabled !== true) {
    return { ok: false, reason: 'owner_provider_disabled' };
  }
  const conversationJid = jidForConfiguredConversation(
    conversation,
    settings.providerAccounts,
  );
  return {
    ok: true,
    owner: {
      ...owner,
      conversationJid,
      providerAccountId,
      providerId: providerAccount.provider,
      externalConversationId: stripProviderPrefix(conversationJid),
    },
  };
}

export function resolveObserverActivationStatus(
  settings: RuntimeSettings,
): ObserverActivationStatus {
  if (!settings.observer.enabled) {
    return {
      state: 'disabled',
      enabled: false,
      active: false,
      reason: 'observer_disabled',
      message: 'Observer is disabled.',
    };
  }
  const resolved = resolveObserverOwnerRoute(settings);
  if (!resolved.ok) {
    return {
      state: 'configuration_required',
      enabled: true,
      active: false,
      reason: resolved.reason,
      message: 'Observer owner and owner DM must be configured.',
    };
  }
  if (!settings.memory.enabled) {
    return {
      state: 'evidence_accumulating',
      enabled: true,
      active: false,
      reason: 'memory_disabled',
      message:
        'Memory is off; evidence is accumulating, but observer promotion is disabled.',
      owner: resolved.owner,
    };
  }
  if (!settings.memory.dreaming.enabled) {
    return {
      state: 'evidence_accumulating',
      enabled: true,
      active: false,
      reason: 'dreaming_disabled',
      message:
        'Dreaming is off; evidence is accumulating, but promotion is disabled.',
      owner: resolved.owner,
    };
  }
  if (
    !settings.memory.embeddings.enabled ||
    settings.memory.embeddings.provider === 'disabled'
  ) {
    return {
      state: 'evidence_accumulating',
      enabled: true,
      active: false,
      reason: 'embeddings_unavailable',
      message: 'Insight emission paused: embeddings unavailable.',
      owner: resolved.owner,
    };
  }
  return {
    state: 'active',
    enabled: true,
    active: true,
    message: 'Observer is active.',
    owner: resolved.owner,
  };
}

export async function resolveVerifiedObserverActivationStatus(
  settings: RuntimeSettings,
  appId: string,
  conversations: ConversationRepository,
): Promise<ObserverActivationStatus> {
  const activation = resolveObserverActivationStatus(settings);
  if (!('owner' in activation)) return activation;

  const storedConversation = await conversations.getConversationByExternalRef({
    appId: appId as AppId,
    providerId: activation.owner.providerId as ProviderId,
    providerAccountId: activation.owner.providerAccountId as ProviderAccountId,
    externalConversationId: activation.owner.externalConversationId,
  });
  if (!storedConversation || storedConversation.kind !== 'direct') {
    return unverifiedOwnerStatus();
  }
  const [participants, approvers] = await Promise.all([
    conversations.listParticipantExternalUserIds(storedConversation.id),
    conversations.listConversationApprovers(storedConversation.id),
  ]);
  const recipient = activation.owner.recipient;
  if (
    !participants.includes(recipient) ||
    !approvers.some((approver) => approver.externalUserId === recipient)
  ) {
    return unverifiedOwnerStatus();
  }
  return activation;
}

export type ObserverDeliveryIneligibleReason =
  | 'observer_disabled'
  | 'delivery_not_configured'
  | 'delivery_disabled'
  | ObserverOwnerResolutionFailure;

export interface ObserverDeliverySchedule {
  timezone: string;
  sendAt: string;
  quietHours?: { start: string; end: string };
  maxInsights: number;
}

export type ObserverDeliveryStatus =
  | {
      eligible: false;
      reason: ObserverDeliveryIneligibleReason;
      message: string;
    }
  | {
      eligible: true;
      owner: ObserverOwnerRoute;
      schedule: ObserverDeliverySchedule;
    };

// Delivery eligibility from settings alone: observer on, delivery opted in, a
// resolvable owner route, and a validated timezone+send_at. The parser already
// guarantees timezone/send_at are present and valid when delivery.enabled, so
// this composes the emission owner route with the parsed schedule. The async
// DB-verified owner route (resolveVerifiedObserverActivationStatus) is layered
// in by the delivery job, which has a ConversationRepository this pure-settings
// helper does not.
export function resolveObserverDeliveryStatus(
  settings: RuntimeSettings,
): ObserverDeliveryStatus {
  if (!settings.observer.enabled) {
    return {
      eligible: false,
      reason: 'observer_disabled',
      message: 'Observer is disabled.',
    };
  }
  const delivery = settings.observer.delivery;
  if (!delivery) {
    return {
      eligible: false,
      reason: 'delivery_not_configured',
      message: 'Observer delivery is not configured.',
    };
  }
  if (!delivery.enabled) {
    return {
      eligible: false,
      reason: 'delivery_disabled',
      message: 'Observer delivery is disabled.',
    };
  }
  const resolved = resolveObserverOwnerRoute(settings);
  if (!resolved.ok) {
    return {
      eligible: false,
      reason: resolved.reason,
      message: 'Observer owner and owner DM must be configured for delivery.',
    };
  }
  if (!delivery.timezone || !delivery.sendAt) {
    return {
      eligible: false,
      reason: 'delivery_not_configured',
      message: 'Observer delivery requires a valid timezone and send time.',
    };
  }
  return {
    eligible: true,
    owner: resolved.owner,
    schedule: {
      timezone: delivery.timezone,
      sendAt: delivery.sendAt,
      ...(delivery.quietHours ? { quietHours: delivery.quietHours } : {}),
      maxInsights: delivery.maxInsights,
    },
  };
}

function unverifiedOwnerStatus(): ObserverActivationStatus {
  return {
    state: 'configuration_required',
    enabled: true,
    active: false,
    reason: 'owner_recipient_not_verified',
    message:
      'Observer owner must be a verified member and persisted control approver of the owner DM.',
  };
}
