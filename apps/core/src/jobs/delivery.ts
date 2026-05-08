import { logger } from '../infrastructure/logging/logger.js';
import type { Job, MessageSendOptions } from '../domain/types.js';
import { isPartialMessageDeliveryError } from '../domain/messages/partial-delivery.js';
import { isAmbiguousDurableDeliveryError } from '../domain/messages/durable-delivery.js';
import {
  buildJobNotificationIdempotencyKey,
  profileIdForJobNotificationPhase,
  resolveJobNotificationRoutes,
  type JobNotificationPhase,
  type JobNotificationRouteSource,
} from './job-notification-routes.js';

export type SchedulerSendMessage = (
  jid: string,
  text: string,
  options?: MessageSendOptions,
) => Promise<void>;

export type DeliverySettlement =
  | 'sent'
  | 'delivery_incomplete'
  | 'not_delivered';

export function isDeliverySent(settlement: DeliverySettlement): boolean {
  return settlement === 'sent';
}

export interface DurableJobNotificationEnqueueInput {
  jobId: string;
  runId?: string | null;
  phase: JobNotificationPhase;
  route: {
    conversationJid: string;
    threadId: string | null;
    label: string;
  };
  profileId: string;
  idempotencyKey: string;
  text: string;
  metadata: Record<string, unknown>;
}

export type EnqueueDurableJobNotification = (
  input: DurableJobNotificationEnqueueInput,
) => Promise<void | boolean>;

export async function settleDeliveryAttempt(
  send: () => Promise<void | boolean>,
  context: { scope: string; target: string },
): Promise<DeliverySettlement> {
  try {
    const result = await send();
    if (typeof result === 'boolean') {
      return result ? 'sent' : 'not_delivered';
    }
    return 'sent';
  } catch (err) {
    if (isAmbiguousDurableDeliveryError(err)) {
      logger.warn(
        {
          scope: context.scope,
          target: context.target,
          provider: err.provider,
          conversationJid: err.conversationJid,
          name: err.name,
        },
        'Delivery attempt has ambiguous durable settlement after visible send; marking as delivery_incomplete',
      );
      return 'delivery_incomplete';
    }
    if (!isPartialMessageDeliveryError(err)) throw err;
    logger.warn(
      {
        scope: context.scope,
        target: context.target,
        deliveredChunks: err.deliveredChunks,
        totalChunks: err.totalChunks,
        name: err.name,
      },
      'Delivery attempt ended in partial visibility; marking as delivery_incomplete',
    );
    return 'delivery_incomplete';
  }
}

export async function sendJobNotification(input: {
  job: Job & JobNotificationRouteSource;
  text: string;
  phase: JobNotificationPhase;
  runId?: string | null;
  sendMessage?: SchedulerSendMessage;
  enqueueDurableNotification?: EnqueueDurableJobNotification;
}): Promise<boolean> {
  if (input.job.silent || !input.text.trim()) return false;
  const routes = resolveJobNotificationRoutes(input.job);
  if (routes.length === 0) return false;
  let delivered = false;

  if (input.enqueueDurableNotification) {
    for (const route of routes) {
      const profileId = profileIdForJobNotificationPhase(input.phase);
      const idempotencyKey = buildJobNotificationIdempotencyKey({
        jobId: input.job.id,
        runId: input.runId,
        phase: input.phase,
        route,
      });
      try {
        const enqueueResult = await input.enqueueDurableNotification({
          jobId: input.job.id,
          runId: input.runId,
          phase: input.phase,
          route,
          profileId,
          idempotencyKey,
          text: input.text,
          metadata: {
            jobId: input.job.id,
            runId: input.runId ?? null,
            phase: input.phase,
            routeLabel: route.label,
            routeConversationJid: route.conversationJid,
            routeThreadId: route.threadId,
          },
        });
        if (enqueueResult !== false) delivered = true;
      } catch (err) {
        logger.warn(
          {
            err,
            jobId: input.job.id,
            phase: input.phase,
            runId: input.runId,
            conversationJid: route.conversationJid,
            threadId: route.threadId,
          },
          'Failed to enqueue durable scheduler notification',
        );
      }
    }
    return delivered;
  }

  const sendMessage = input.sendMessage;
  if (!sendMessage) return false;
  for (const route of routes) {
    const options = route.threadId ? { threadId: route.threadId } : undefined;
    try {
      const settlement = await settleDeliveryAttempt(
        () =>
          options
            ? sendMessage(route.conversationJid, input.text, options)
            : sendMessage(route.conversationJid, input.text),
        { scope: 'job-notification', target: route.conversationJid },
      );
      if (isDeliverySent(settlement)) delivered = true;
    } catch (err) {
      logger.warn(
        { jobId: input.job.id, jid: route.conversationJid, err },
        'Failed to send scheduler status message',
      );
    }
  }
  return delivered;
}
