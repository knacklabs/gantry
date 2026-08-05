type ActiveTurnUiCleanup = {
  turnMarker: symbol;
  cancel: () => void | Promise<void>;
};

const TERMINAL_CLEANUP_WAIT_TIMEOUT_MS = 2_000;

export const activeTurnUiCleanupByQueue = new Map<
  string,
  ActiveTurnUiCleanup
>();

export async function awaitActiveTurnUiCleanup(
  queueJid: string,
  log: {
    warn(metadata: Record<string, unknown>, message: string): void;
  },
): Promise<void> {
  const cleanup = activeTurnUiCleanupByQueue.get(queueJid);
  if (!cleanup) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      Promise.resolve()
        .then(() => cleanup.cancel())
        .then(
          () => true,
          (err) => {
            log.warn(
              { err, queueJid },
              'Previous turn terminal cleanup failed; admitting next turn',
            );
            return true;
          },
        ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          TERMINAL_CLEANUP_WAIT_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
    if (!completed) {
      log.warn(
        { queueJid, timeoutMs: TERMINAL_CLEANUP_WAIT_TIMEOUT_MS },
        'Previous turn terminal cleanup timed out; admitting next turn',
      );
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (activeTurnUiCleanupByQueue.get(queueJid) === cleanup) {
      activeTurnUiCleanupByQueue.delete(queueJid);
    }
  }
}
