import { logger } from '../core/logger.js';
import type { Job, MessageSendOptions } from '../core/types.js';

export type SchedulerSendMessage = (
  jid: string,
  text: string,
  options?: MessageSendOptions,
) => Promise<void>;

export async function notifyLinkedSessions(
  job: Job,
  text: string,
  sendMessage: SchedulerSendMessage,
): Promise<boolean> {
  const unique = Array.from(new Set(job.linked_sessions));
  const options = job.thread_id ? { threadId: job.thread_id } : undefined;
  let delivered = false;
  for (const jid of unique) {
    try {
      await (options
        ? sendMessage(jid, text, options)
        : sendMessage(jid, text));
      delivered = true;
    } catch (err) {
      logger.warn(
        { jobId: job.id, jid, err },
        'Failed to send scheduler status message',
      );
    }
  }
  return delivered;
}
