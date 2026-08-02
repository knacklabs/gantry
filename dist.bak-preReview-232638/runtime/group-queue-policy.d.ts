export declare const UNLIMITED_QUEUE_BACKLOG = 0;
export interface GroupQueuePolicy {
    maxRetries: number;
    baseRetryMs: number;
    maxMessageRuns: number;
    maxJobRuns: number;
    maxMessageBacklog: number;
    maxTaskBacklog: number;
}
export interface GroupQueuePolicyOptions {
    maxRetries?: number;
    baseRetryMs?: number;
    maxMessageRuns?: number;
    maxJobRuns?: number;
    maxMessageBacklog?: number;
    maxTaskBacklog?: number;
}
export declare function createGroupQueuePolicy(options: GroupQueuePolicyOptions): GroupQueuePolicy;
export declare function continuationSenderMatchesRequiredUser(senderUserIds: readonly string[] | null | undefined, requiredUserId: string): boolean;
