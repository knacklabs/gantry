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

export function createChannelAttachmentDeletionHandler(
  appId: string,
  repository: () => MessageAttachmentRepository,
  options: {
    retryDelayMs?: number;
    warn?: (context: Record<string, unknown>, message: string) => void;
  } = {},
): (event: ChannelAttachmentDeletionEvent) => Promise<void> {
  const retry = createMessageAttachmentDeletionRetryWorker(repository, options);
  retry.trigger();
  return async (event) => {
    try {
      await repository().setDeletedAtByMessageExternalIds({
        ...event,
        appId,
        providerAccountIds: event.providerAccountIds ?? [],
      });
    } finally {
      retry.trigger();
    }
  };
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
