import type { ProactiveInsight } from '../domain/ports/observer-insights.js';
/**
 * Minimal read surface the freshness probe needs. `getMessagesSince` already
 * returns only inbound (non-bot) messages after the cursor, so a non-empty
 * result means the conversation moved on after the insight was snapshotted.
 * RuntimeMessageRepository satisfies this structurally.
 */
export interface FreshnessMessageReader {
    getMessagesSince(conversationJid: string, sinceCursor: string, limit?: number, options?: {
        threadId?: string | null;
        providerAccountId?: string | null;
    }): Promise<unknown[]>;
}
export interface InsightFreshnessProbe {
    isStale(insight: Pick<ProactiveInsight, 'batchSnapshotAt' | 'evidenceRefs'>): Promise<boolean>;
}
export declare class MessageInsightFreshnessProbe implements InsightFreshnessProbe {
    private readonly messages;
    constructor(messages: FreshnessMessageReader);
    isStale(insight: Pick<ProactiveInsight, 'batchSnapshotAt' | 'evidenceRefs'>): Promise<boolean>;
}
