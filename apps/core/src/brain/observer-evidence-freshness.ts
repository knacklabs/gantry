import type { ProactiveInsight } from '../domain/ports/observer-insights.js';

/**
 * Minimal read surface the freshness probe needs. `getMessagesSince` already
 * returns only inbound (non-bot) messages after the cursor, so a non-empty
 * result means the conversation moved on after the insight was snapshotted.
 * RuntimeMessageRepository satisfies this structurally.
 */
export interface FreshnessMessageReader {
  getMessagesSince(
    conversationJid: string,
    sinceCursor: string,
    limit?: number,
    options?: { threadId?: string | null; providerAccountId?: string | null },
  ): Promise<unknown[]>;
}

export interface InsightFreshnessProbe {
  isStale(
    insight: Pick<ProactiveInsight, 'batchSnapshotAt' | 'evidenceRefs'>,
  ): Promise<boolean>;
}

export class MessageInsightFreshnessProbe implements InsightFreshnessProbe {
  constructor(private readonly messages: FreshnessMessageReader) {}

  async isStale(
    insight: Pick<ProactiveInsight, 'batchSnapshotAt' | 'evidenceRefs'>,
  ): Promise<boolean> {
    const refs = insight.evidenceRefs ?? [];
    // No evidence, or evidence missing account-qualified provenance, is
    // unverifiable -> fail closed and treat the insight as stale. Legacy rows
    // persisted before the provenance fix land here.
    if (refs.length === 0) return true;
    if (refs.some((ref) => !ref.providerAccountId || !ref.conversationJid)) {
      return true;
    }
    for (const ref of refs) {
      // Only add a thread filter when the evidence is thread-scoped: passing
      // threadId at all makes the reader filter (undefined -> top-level only),
      // which would wrongly narrow conversation-level evidence.
      const options: {
        providerAccountId: string;
        threadId?: string | null;
      } = { providerAccountId: ref.providerAccountId! };
      if (ref.threadId) options.threadId = ref.threadId;
      const later = await this.messages.getMessagesSince(
        ref.conversationJid!,
        insight.batchSnapshotAt,
        1,
        options,
      );
      if (later.length > 0) return true;
    }
    return false;
  }
}
