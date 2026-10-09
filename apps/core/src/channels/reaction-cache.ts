export async function updateReactionCache(
  input: {
    reactionKeys: Set<string>;
    key: string;
    operation: 'add' | 'remove';
    messagePrefix?: string;
    signal?: AbortSignal;
    reconcile?: boolean;
  },
  request: () => Promise<unknown>,
): Promise<void> {
  if (
    input.operation === 'add' &&
    !input.reconcile &&
    input.reactionKeys.has(input.key)
  ) {
    return;
  }
  const invalidate = () => {
    if (input.messagePrefix === undefined) {
      input.reactionKeys.delete(input.key);
    } else {
      for (const key of input.reactionKeys) {
        if (key.startsWith(input.messagePrefix)) input.reactionKeys.delete(key);
      }
    }
  };
  if (input.reconcile) invalidate();
  input.signal?.addEventListener('abort', invalidate, { once: true });
  try {
    await request();
    if (!input.signal?.aborted) {
      invalidate();
      if (input.operation === 'add') input.reactionKeys.add(input.key);
    }
  } finally {
    input.signal?.removeEventListener('abort', invalidate);
  }
}
