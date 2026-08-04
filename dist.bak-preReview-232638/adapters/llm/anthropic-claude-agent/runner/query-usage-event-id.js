export function usageEventIdForMessage(message, sessionId, resultCount, queryRunId) {
    if (typeof message === 'object' && message !== null) {
        const record = message;
        for (const key of ['uuid', 'message_uuid', 'id', 'request_id']) {
            const value = record[key];
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
    }
    return `${sessionId ?? 'new'}:run:${queryRunId}:result:${resultCount}`;
}
