import type { PgBoss } from 'pg-boss';
import type { Job } from '../../domain/types.js';
type SchedulerDelaySendMessage = (jid: string, text: string, options?: {
    threadId?: string;
}) => Promise<void | boolean>;
export declare function requeueRunSlotBlockedDelivery(input: {
    boss: Pick<PgBoss, 'send'>;
    queueName: string;
    groupId: string;
    job: Job;
    payload: {
        jobId?: string;
        runId?: string | null;
        triggerId?: string | null;
        scheduledFor?: string | null;
        capacityDelayNotified?: boolean;
    };
    sendMessage: SchedulerDelaySendMessage;
}): Promise<void>;
export {};
