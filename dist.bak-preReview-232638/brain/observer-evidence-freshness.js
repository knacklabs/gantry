export class MessageInsightFreshnessProbe {
    messages;
    constructor(messages) {
        this.messages = messages;
    }
    async isStale(insight) {
        const refs = insight.evidenceRefs ?? [];
        // No evidence, or evidence missing account-qualified provenance, is
        // unverifiable -> fail closed and treat the insight as stale. Legacy rows
        // persisted before the provenance fix land here.
        if (refs.length === 0)
            return true;
        if (refs.some((ref) => !ref.providerAccountId || !ref.conversationJid)) {
            return true;
        }
        for (const ref of refs) {
            // Only add a thread filter when the evidence is thread-scoped: passing
            // threadId at all makes the reader filter (undefined -> top-level only),
            // which would wrongly narrow conversation-level evidence.
            const options = { providerAccountId: ref.providerAccountId };
            if (ref.threadId)
                options.threadId = ref.threadId;
            const later = await this.messages.getMessagesSince(ref.conversationJid, insight.batchSnapshotAt, 1, options);
            if (later.length > 0)
                return true;
        }
        return false;
    }
}
