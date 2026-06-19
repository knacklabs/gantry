import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';

import type { Job } from '../../domain/types.js';
import { JOB_INTERACTIVE_CAPACITY_RESERVED_DELAY_TEXT } from '../../shared/scheduler-copy.js';
import { nowMs as currentTimeMs, toIso } from '../../shared/time/datetime.js';
import { logger } from '../logging/logger.js';
import { schedulerDeliveryPriorityForJob } from './scheduler-admission.js';

type SchedulerDelaySendMessage = (
  jid: string,
  text: string,
  options?: { threadId?: string },
) => Promise<void | boolean>;

const deliveredCapacityDelayNotifications = new Set<string>();
const CAPACITY_DELAY_NOTIFICATION_TIMEOUT_MS = 5_000;

export async function requeueRunSlotBlockedDelivery(input: {
  boss: Pick<PgBoss, 'send'>;
  queueName: string;
  groupId: string;
  job: Job;
  payload: {
    jobId?: string;
    runId?: string | null;
    triggerId?: string | null;
    scheduledFor?: string | null;
    capacityDelayNotified?: boolean;
  };
  sendMessage: SchedulerDelaySendMessage;
}): Promise<void> {
  const startAfter = toIso(currentTimeMs() + runSlotRequeueDelayMs());
  const notificationKey = capacityDelayNotificationKey(input);
  const capacityDelayNotified =
    input.payload.capacityDelayNotified === true ||
    deliveredCapacityDelayNotifications.has(notificationKey);
  try {
    const delivered = capacityDelayNotified
      ? false
      : await notifySchedulerRunDelayedByCapacity(input);
    const nextCapacityDelayNotified = capacityDelayNotified || delivered;
    await input.boss.send(
      input.queueName,
      {
        ...input.payload,
        jobId: input.job.id,
        capacityDelayNotified: nextCapacityDelayNotified,
      },
      {
        id: randomUUID(),
        startAfter,
        group: { id: input.groupId },
        retryLimit: 0,
        priority: schedulerDeliveryPriorityForJob(input.job),
      },
    );
    logger.info(
      { jobId: input.job.id, startAfter },
      'Requeued scheduler delivery while run slot capacity is full',
    );
    if (delivered) deliveredCapacityDelayNotifications.add(notificationKey);
  } catch (err) {
    logger.warn(
      { err, jobId: input.job.id },
      'Failed to requeue scheduler delivery blocked on run slot capacity',
    );
    throw err;
  }
}

function capacityDelayNotificationKey(input: {
  job: Job;
  payload: {
    jobId?: string;
    runId?: string | null;
    triggerId?: string | null;
    scheduledFor?: string | null;
  };
}): string {
  return (
    [
      input.payload.runId,
      input.payload.triggerId,
      input.payload.scheduledFor,
      input.payload.jobId,
      input.job.id,
    ]
      .find((part) => part?.trim())
      ?.trim() ?? input.job.id
  );
}

async function notifySchedulerRunDelayedByCapacity(input: {
  job: Job;
  sendMessage: SchedulerDelaySendMessage;
}): Promise<boolean> {
  if (input.job.silent) return true;
  let delivered = false;
  for (const route of notificationRoutesForJob(input.job)) {
    const options = route.threadId ? { threadId: route.threadId } : undefined;
    try {
      const result = await withCapacityDelayNotificationTimeout(
        options
          ? input.sendMessage(
              route.conversationJid,
              JOB_INTERACTIVE_CAPACITY_RESERVED_DELAY_TEXT,
              options,
            )
          : input.sendMessage(
              route.conversationJid,
              JOB_INTERACTIVE_CAPACITY_RESERVED_DELAY_TEXT,
            ),
        input.job.id,
        route.conversationJid,
      );
      if (result !== false) delivered = true;
    } catch (err) {
      logger.warn(
        { err, jobId: input.job.id, jid: route.conversationJid },
        'Failed to send scheduler capacity delay status message',
      );
    }
  }
  return delivered;
}

async function withCapacityDelayNotificationTimeout<T>(
  delivery: Promise<T>,
  jobId: string,
  conversationJid: string,
): Promise<T | false> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      delivery,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => {
          logger.warn(
            { jobId, jid: conversationJid },
            'Timed out sending scheduler capacity delay status message',
          );
          resolve(false);
        }, CAPACITY_DELAY_NOTIFICATION_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function notificationRoutesForJob(
  job: Job,
): Array<{ conversationJid: string; threadId: string | null }> {
  const routes = job.notification_routes?.length
    ? job.notification_routes
    : job.execution_context
      ? [
          {
            conversationJid: job.execution_context.conversationJid,
            threadId: job.execution_context.threadId,
          },
        ]
      : [];
  const seen = new Set<string>();
  const unique: Array<{ conversationJid: string; threadId: string | null }> =
    [];
  for (const route of routes) {
    const conversationJid = route.conversationJid?.trim();
    if (!conversationJid) continue;
    const threadId = route.threadId?.trim() || null;
    const key = `${conversationJid}\0${threadId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ conversationJid, threadId });
  }
  return unique;
}

function runSlotRequeueDelayMs(random: () => number = Math.random): number {
  return 1_000 + Math.floor(random() * 4_000);
}
