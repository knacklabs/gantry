export function usageEventIdForMessage(
  message: unknown,
  sessionId: string | undefined,
  resultCount: number,
  queryRunId: string,
): string {
  if (typeof message === 'object' && message !== null) {
    const record = message as Record<string, unknown>;
    for (const key of ['uuid', 'message_uuid', 'id', 'request_id']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  return `${sessionId ?? 'new'}:run:${queryRunId}:result:${resultCount}`;
}
