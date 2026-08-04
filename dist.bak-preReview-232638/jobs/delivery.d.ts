import type { Job, MessageSendOptions } from '../domain/types.js';
import { type JobNotificationPhase, type JobNotificationRouteSource } from './job-notification-routes.js';
export type SchedulerSendMessage = (jid: string, text: string, options?: MessageSendOptions) => Promise<void>;
export type DeliverySettlement = 'sent' | 'delivery_incomplete' | 'not_delivered';
export declare function isDeliverySent(settlement: DeliverySettlement): boolean;
export declare function formatDeliveryIncomplete(input: {
    provider: string;
    rejectedPart: number;
    totalParts: number;
}): string;
export interface DurableJobNotificationEnqueueInput {
    jobId: string;
    runId?: string | null;
    phase: JobNotificationPhase;
    route: {
        conversationJid: string;
        threadId: string | null;
        providerAccountId?: string;
        label: string;
    };
    profileId: string;
    idempotencyKey: string;
    text: string;
    metadata: Record<string, unknown>;
}
export type EnqueueDurableJobNotification = (input: DurableJobNotificationEnqueueInput) => Promise<void | boolean>;
export declare function settleDeliveryAttempt(send: () => Promise<void | boolean>, context: {
    scope: string;
    target: string;
}): Promise<DeliverySettlement>;
export declare function sendJobNotification(input: {
    job: Job & JobNotificationRouteSource;
    text: string;
    phase: JobNotificationPhase;
    runId?: string | null;
    actionAffordances?: MessageSendOptions['actionAffordances'];
    sendMessage?: SchedulerSendMessage;
    enqueueDurableNotification?: EnqueueDurableJobNotification;
}): Promise<boolean>;
