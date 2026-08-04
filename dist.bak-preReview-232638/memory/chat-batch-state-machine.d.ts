import type { AppId } from '../domain/app/app.js';
import type { ChatBatchRecord, ChatBatchRepository } from '../domain/ports/chat-batches.js';
import type { MemoryLlmBatchCapability, MemoryLlmBatchRequest, MemoryLlmModelProfile } from '../domain/ports/memory-llm-client.js';
export declare const DEFAULT_CHAT_BATCH_MAX_SNAPSHOT_BYTES: number;
export declare const DEFAULT_CHAT_BATCH_RETRY_LIMIT = 5;
export declare const DEFAULT_CHAT_BATCH_RETENTION_MS: number;
export interface ChatBatchSubmitInput {
    appId: AppId;
    providerId: string;
    model: string;
    modelProfile?: MemoryLlmModelProfile;
    correlationId?: string;
    requests: MemoryLlmBatchRequest[];
    maxOutputTokens: number;
    reservedCostUsd: number;
    dailyCostLimitUsd: number;
    signal?: AbortSignal;
}
export interface ChatBatchStateMachineOptions {
    repository: ChatBatchRepository;
    resolveCapability: (batch: Pick<ChatBatchRecord, 'appId' | 'providerId' | 'model'>) => MemoryLlmBatchCapability | undefined;
    now?: () => Date;
    createId?: () => string;
    maxSnapshotBytes?: number;
    retryLimit?: number;
    retentionMsForProvider?: (providerId: string) => number;
}
export interface ChatBatchReconcileSummary {
    inspected: number;
    adopted: number;
    abandoned: number;
    unresolved: number;
}
export declare class ChatBatchStateMachine {
    private readonly options;
    private readonly now;
    private readonly createId;
    private readonly maxSnapshotBytes;
    private readonly retryLimit;
    private readonly retentionMsForProvider;
    constructor(options: ChatBatchStateMachineOptions);
    submit(input: ChatBatchSubmitInput): Promise<ChatBatchRecord>;
    pollAndApply(input: {
        batchId: string;
        modelProfile?: MemoryLlmModelProfile;
        signal?: AbortSignal;
    }): Promise<ChatBatchRecord>;
    reconcileSubmissionUnknown(input?: {
        appId?: string;
        limit?: number;
        signal?: AbortSignal;
    }): Promise<ChatBatchReconcileSummary>;
    private requireBatch;
    private recordAttemptFailure;
}
