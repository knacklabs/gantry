const THREAD_QUEUE_MARKER = '::thread:';

export function normalizeThreadQueueId(
  threadId?: string | null,
): string | undefined {
  const normalized = threadId?.trim();
  return normalized || undefined;
}

export function makeThreadQueueKey(
  chatJid: string,
  threadId?: string | null,
): string {
  const normalized = normalizeThreadQueueId(threadId);
  if (!normalized) return chatJid;
  return `${chatJid}${THREAD_QUEUE_MARKER}${encodeURIComponent(normalized)}`;
}

export function parseThreadQueueKey(queueJid: string): {
  chatJid: string;
  threadId?: string;
} {
  const markerIndex = queueJid.lastIndexOf(THREAD_QUEUE_MARKER);
  if (markerIndex < 0) return { chatJid: queueJid };

  const chatJid = queueJid.slice(0, markerIndex);
  const encodedThreadId = queueJid.slice(
    markerIndex + THREAD_QUEUE_MARKER.length,
  );
  if (!chatJid || !encodedThreadId) return { chatJid: queueJid };

  try {
    return {
      chatJid,
      threadId: normalizeThreadQueueId(decodeURIComponent(encodedThreadId)),
    };
  } catch {
    return { chatJid: queueJid };
  }
}

export function firstThreadQueueId(
  ...threadIds: Array<string | null | undefined>
): string | undefined {
  for (const threadId of threadIds) {
    const normalized = normalizeThreadQueueId(threadId);
    if (normalized) return normalized;
  }
  return undefined;
}
