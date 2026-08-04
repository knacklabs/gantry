import type { ChatBatchRecord, ChatBatchRepository, ChatBatchUsage } from '../../../../domain/ports/chat-batches.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresChatBatchRepository implements ChatBatchRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    createIntent(input: Parameters<ChatBatchRepository['createIntent']>[0]): Promise<ChatBatchRecord>;
    findById(id: string): Promise<ChatBatchRecord | null>;
    findByCorrelationId(input: {
        appId: string;
        providerId: string;
        correlationId: string;
    }): Promise<ChatBatchRecord | null>;
    listSubmissionUnknown(input: {
        appId?: string;
        limit: number;
    }): Promise<ChatBatchRecord[]>;
    recordPreflightFailure(input: Parameters<ChatBatchRepository['recordPreflightFailure']>[0]): Promise<ChatBatchRecord>;
    markSubmissionUnknown(input: {
        id: string;
        nowIso: string;
    }): Promise<ChatBatchRecord | null>;
    markSubmitted(input: {
        id: string;
        providerBatchId: string;
        nowIso: string;
    }): Promise<ChatBatchRecord | null>;
    markProcessing(input: {
        id: string;
        nowIso: string;
    }): Promise<ChatBatchRecord | null>;
    recordAttemptError(input: {
        id: string;
        phase: 'poll' | 'result';
        error: string;
        terminal: boolean;
        nowIso: string;
    }): Promise<ChatBatchRecord | null>;
    applyResults(input: {
        id: string;
        results: readonly Record<string, unknown>[];
        usage: ChatBatchUsage;
        nowIso: string;
    }): Promise<ChatBatchRecord | null>;
    abandonSubmission(input: {
        id: string;
        reason: string;
        nowIso: string;
    }): Promise<ChatBatchRecord | null>;
}
