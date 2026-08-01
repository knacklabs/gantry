import type {
  MessageAttachmentDeletionScope,
  MessageAttachmentRepository,
} from '../../domain/ports/message-attachment-repository.js';

type ChannelAttachmentDeletionEvent = Omit<
  MessageAttachmentDeletionScope,
  'appId' | 'providerAccountIds'
> & {
  providerAccountIds?: readonly string[];
};

const RAW_DELETION_RETRY_INITIAL_MS = 100;
export const RAW_DELETION_RETRY_MAX_MS = 2_000;

export function createChannelAttachmentDeletionHandler(
  appId: string,
  repository: () => MessageAttachmentRepository,
  options: {
    retryDelayMs?: number;
    warn?: (context: Record<string, unknown>, message: string) => void;
  } = {},
): (event: ChannelAttachmentDeletionEvent) => Promise<void> {
  const markerRetry = createMessageAttachmentDeletionRetryWorker(
    repository,
    options,
  );
  const rawRetry = createRawMessageAttachmentDeletionRetryWorker(
    appId,
    repository,
    options,
  );
  markerRetry.trigger();
  return async (event) => {
    const scope = {
      ...event,
      appId,
      providerAccountIds: event.providerAccountIds ?? [],
    };
    try {
      await repository().setDeletedAtByMessageExternalIds(scope);
    } catch (err) {
      rawRetry.retain(scope);
      throw err;
    }
    markerRetry.trigger();
  };
}

function createRawMessageAttachmentDeletionRetryWorker(
  appId: string,
  repository: () => MessageAttachmentRepository,
  options: {
    retryDelayMs?: number;
    warn?: (context: Record<string, unknown>, message: string) => void;
  },
): { retain: (scope: MessageAttachmentDeletionScope) => void } {
  const pending = new Map<string, MessageAttachmentDeletionScope>();
  let worker: Promise<void> | undefined;
  const ensureWorker = () => {
    if (worker || pending.size === 0) return;
    worker = retryUntilDurable().finally(() => {
      worker = undefined;
      ensureWorker();
    });
  };
  const retryUntilDurable = async () => {
    let retryMs = options.retryDelayMs ?? RAW_DELETION_RETRY_INITIAL_MS;
    while (pending.size > 0) {
      await waitForRetry(retryMs);
      let failed = false;
      for (const [key, scope] of [...pending]) {
        try {
          await repository().setDeletedAtByMessageExternalIds(scope);
          if (pending.get(key) === scope) pending.delete(key);
        } catch (err) {
          failed = true;
          options.warn?.(
            { err, channelId: scope.channelId },
            'Failed to persist raw message attachment deletion; retrying in background',
          );
        }
      }
      retryMs = failed
        ? Math.min(RAW_DELETION_RETRY_MAX_MS, retryMs * 2)
        : (options.retryDelayMs ?? RAW_DELETION_RETRY_INITIAL_MS);
    }
  };
  return {
    retain: (scope) => {
      const retainedScope = { ...scope, appId };
      pending.set(retainedScopeKey(retainedScope), retainedScope);
      ensureWorker();
    },
  };
}

function retainedScopeKey(scope: MessageAttachmentDeletionScope): string {
  return JSON.stringify([
    scope.appId,
    scope.providerId,
    scope.channelId,
    scope.deletedAt,
    [...new Set(scope.providerAccountIds)].sort(),
    [...new Set(scope.externalMessageIds)].sort(),
  ]);
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export function createMessageAttachmentDeletionRetryWorker(
  repository: () => MessageAttachmentRepository,
  options: {
    retryDelayMs?: number;
    warn?: (context: Record<string, unknown>, message: string) => void;
  } = {},
): { trigger: () => void } {
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let requested = false;

  const schedule = () => {
    if (timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, retryDelayMs);
    timer.unref?.();
  };
  const run = async () => {
    if (running) return;
    running = true;
    requested = false;
    let pending = false;
    try {
      pending = await repository().retryPendingMessageAttachmentDeletions();
    } catch (err) {
      pending = true;
      options.warn?.(
        { err },
        'Failed to retry pending message attachment deletions',
      );
    } finally {
      running = false;
    }
    if (pending || requested) schedule();
  };

  return {
    trigger: () => {
      requested = true;
      schedule();
    },
  };
}
