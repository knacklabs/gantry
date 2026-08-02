import type { ConversationRepository } from '../../domain/ports/repositories.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
export type ObserverOwnerResolutionFailure = 'owner_not_configured' | 'owner_conversation_not_found' | 'owner_conversation_not_direct' | 'owner_recipient_not_approver' | 'owner_recipient_not_verified' | 'owner_provider_account_not_found' | 'owner_provider_account_disabled' | 'owner_provider_disabled';
export interface ObserverOwnerRoute {
    recipient: string;
    conversation: string;
    conversationJid: string;
    providerAccountId: string;
    providerId: string;
    externalConversationId: string;
}
export type ObserverOwnerResolution = {
    ok: true;
    owner: ObserverOwnerRoute;
} | {
    ok: false;
    reason: ObserverOwnerResolutionFailure;
};
export type ObserverActivationStatus = {
    state: 'disabled';
    enabled: false;
    active: false;
    reason: 'observer_disabled';
    message: string;
} | {
    state: 'configuration_required';
    enabled: true;
    active: false;
    reason: ObserverOwnerResolutionFailure;
    message: string;
} | {
    state: 'evidence_accumulating';
    enabled: true;
    active: false;
    reason: 'dreaming_disabled' | 'memory_disabled' | 'embeddings_unavailable';
    message: string;
    owner: ObserverOwnerRoute;
} | {
    state: 'active';
    enabled: true;
    active: true;
    message: string;
    owner: ObserverOwnerRoute;
};
export declare function resolveObserverOwnerRoute(settings: RuntimeSettings): ObserverOwnerResolution;
export declare function resolveObserverActivationStatus(settings: RuntimeSettings): ObserverActivationStatus;
export declare function resolveVerifiedObserverActivationStatus(settings: RuntimeSettings, appId: string, conversations: ConversationRepository): Promise<ObserverActivationStatus>;
export type ObserverDeliveryIneligibleReason = 'observer_disabled' | 'delivery_not_configured' | 'delivery_disabled' | ObserverOwnerResolutionFailure;
export interface ObserverDeliverySchedule {
    timezone: string;
    sendAt: string;
    quietHours?: {
        start: string;
        end: string;
    };
    maxInsights: number;
}
export type ObserverDeliveryStatus = {
    eligible: false;
    reason: ObserverDeliveryIneligibleReason;
    message: string;
} | {
    eligible: true;
    owner: ObserverOwnerRoute;
    schedule: ObserverDeliverySchedule;
};
export declare function resolveObserverDeliveryStatus(settings: RuntimeSettings): ObserverDeliveryStatus;
