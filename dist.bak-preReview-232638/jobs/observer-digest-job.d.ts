import type { resolveObserverDeliveryStatus } from '../config/settings/observer-activation.js';
import { type DigestSendGateway } from '../brain/observer-digest.js';
import type { ConversationRoute } from '../domain/types.js';
import type { SchedulerDependencies } from './types.js';
export declare const OBSERVER_DIGEST_TIMEOUT_MS: number;
export declare const OBSERVER_DIGEST_CRON = "*/30 * * * *";
export declare const OBSERVER_DIGEST_JOB_ID = "system:observer-digest:default";
type ObserverDeliveryStatus = ReturnType<typeof resolveObserverDeliveryStatus>;
export declare function setObserverDigestGateway(gateway: DigestSendGateway | null): void;
export declare function observerRegistrationSignatureFields(observerDeliveryStatus: ObserverDeliveryStatus): {
    observerDigestEligible: boolean;
    observerDigestCron: string;
    observerDigestOwner: string | null;
};
export declare function registerObserverDigestJob(deps: SchedulerDependencies, input: {
    observerDeliveryStatus: ObserverDeliveryStatus;
    primary: {
        jid: string;
        group: ConversationRoute;
    } | undefined;
    nowIso: string;
}): Promise<void>;
export declare function runScheduledObserverDigest(signal?: AbortSignal): Promise<string>;
export {};
