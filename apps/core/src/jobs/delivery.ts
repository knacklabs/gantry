import { logger } from '../infrastructure/logging/logger.js';
import type { Job, MessageSendOptions } from '../domain/types.js';
import {
  getPartialMessageDeliveryMetadata,
  isPartialMessageDeliveryError,
} from '../domain/messages/partial-delivery.js';
import { isAmbiguousDurableDeliveryError } from '../domain/messages/durable-delivery.js';
import { formatOperatorError } from '../shared/operator-error.js';
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

export function formatDeliveryIncomplete(input: {
  provider: string;
  rejectedPart: number;
  totalParts: number;
}): string {
  return formatOperatorError({
    summary: 'Message delivery incomplete.',
    cause: `${input.provider} rejected part ${input.rejectedPart}/${input.totalParts}`,
    recover: 'see logs for the full output and retry after fixing delivery.',
  });
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
    const metadata = getPartialMessageDeliveryMetadata(err);
    const deliveredParts = metadata.deliveredParts ?? err.deliveredChunks;
    const totalParts = metadata.totalParts ?? err.totalChunks;
    const provider =
      metadata.provider ??
      providerFromPayload(metadata.retryTail?.providerPayload) ??
      'provider';
    logger.warn(
      {
        scope: context.scope,
        target: context.target,
        provider,
        deliveredChunks: err.deliveredChunks,
        totalChunks: err.totalChunks,
        name: err.name,
        operatorMessage: formatDeliveryIncomplete({
          provider,
          rejectedPart: Math.min(deliveredParts + 1, totalParts),
          totalParts,
        }),
      },
      'Delivery attempt ended in partial visibility; marking as delivery_incomplete',
    );
    return 'delivery_incomplete';
  }
}

function providerFromPayload(providerPayload: unknown): string | undefined {
  if (typeof providerPayload !== 'object' || providerPayload === null) {
    return undefined;
  }
  const provider = (providerPayload as { provider?: unknown }).provider;
  if (typeof provider !== 'string') return undefined;
  const trimmed = provider.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function sendJobNotification(input: {
  job: Job & JobNotificationRouteSource;
  text: string;
  phase: JobNotificationPhase;
  runId?: string | null;
  actionAffordances?: MessageSendOptions['actionAffordances'];
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
    const options =
      route.threadId || input.actionAffordances
        ? {
            ...(route.threadId ? { threadId: route.threadId } : {}),
            ...(input.actionAffordances
              ? { actionAffordances: input.actionAffordances }
              : {}),
          }
        : undefined;
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
