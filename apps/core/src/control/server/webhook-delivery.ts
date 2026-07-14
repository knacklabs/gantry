import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { logger } from '../../infrastructure/logging/logger.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import { PostgresEventBusOutboxConsumer } from '../../adapters/storage/postgres/repositories/event-bus-outbox.postgres.js';
import type {
  RuntimeEvent,
  RuntimeEventId,
} from '../../domain/events/events.js';
import {
  hostnameForNetwork,
  type ResolvedWebhookTarget,
  validateWebhookTarget,
} from './webhook-target.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';

const WEBHOOK_DELIVERY_BATCH_SIZE = 20;
const WEBHOOK_DELIVERY_CONCURRENCY = 4;
const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

type WebhookDeliveryEnvelopeEvent = Pick<
  RuntimeEvent,
  | 'eventId'
  | 'eventType'
  | 'agentId'
  | 'sessionId'
  | 'jobId'
  | 'runId'
  | 'triggerId'
  | 'conversationId'
  | 'threadId'
  | 'correlationId'
  | 'createdAt'
  | 'payload'
>;

export function buildWebhookDeliveryEnvelope(
  event: WebhookDeliveryEnvelopeEvent,
): Record<string, unknown> {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    agentId: event.agentId ?? null,
    sessionId: event.sessionId ?? null,
    jobId: event.jobId ?? null,
    runId: event.runId ?? null,
    triggerId: event.triggerId ?? null,
    conversationId: event.conversationId ?? null,
    threadId: event.threadId ?? null,
    correlationId: event.correlationId ?? null,
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

async function requestWebhook(
  target: ResolvedWebhookTarget,
  headers: Record<string, string>,
  body: string,
): Promise<{ ok: boolean; status: number }> {
  const transport = target.url.protocol === 'https:' ? https : http;
  return await new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.url.protocol,
        hostname: hostnameForNetwork(target.url.hostname),
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        headers,
        servername: hostnameForNetwork(target.url.hostname),
        lookup: (_hostname, _options, callback) => {
          callback(null, target.address, target.family);
        },
        timeout: WEBHOOK_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          const status = response.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status });
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error('Webhook request timed out'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

export async function deliverWebhookDelivery(
  delivery: Awaited<
    ReturnType<
      ReturnType<
        typeof getRuntimeControlRepository
      >['claimDueWebhookDeliveries']
    >
  >[number],
): Promise<void> {
  const control = getRuntimeControlRepository();
  const attemptCount = delivery.attemptCount;
  const { webhook, event } = delivery;
  if (!webhook || !event || !webhook.enabled) {
    await control.markWebhookDeliveryDead(
      delivery.deliveryId,
      'Webhook registration or event no longer available',
    );
    return;
  }
  if (delivery.eventAppId !== webhook.appId) {
    await control.markWebhookDeliveryDead(
      delivery.deliveryId,
      'Webhook registration does not belong to event app',
    );
    return;
  }
  try {
    const runtimeEvent = (
      await getRuntimeEventExchange().list({
        appId: webhook.appId as RuntimeEvent['appId'],
        afterEventId: (event.eventId - 1) as RuntimeEventId,
        limit: 1,
      })
    ).find((candidate) => candidate.eventId === event.eventId);
    const body = JSON.stringify(
      buildWebhookDeliveryEnvelope(
        runtimeEvent ?? {
          eventId: event.eventId as RuntimeEventId,
          eventType: event.eventType as RuntimeEvent['eventType'],
          agentId: undefined,
          sessionId: event.sessionId as RuntimeEvent['sessionId'],
          jobId: event.jobId as RuntimeEvent['jobId'],
          runId: event.runId as RuntimeEvent['runId'],
          triggerId: event.triggerId ?? undefined,
          conversationId: undefined,
          threadId: undefined,
          correlationId: event.correlationId ?? undefined,
          createdAt: event.createdAt as RuntimeEvent['createdAt'],
          payload: JSON.parse(event.payload),
        },
      ),
    );
    const target = await validateWebhookTarget(webhook.url);
    const timestamp = String(currentTimeMs());
    const signature = createHmac('sha256', webhook.secret)
      .update(`${timestamp}.${event.eventId}.${event.eventType}.${body}`)
      .digest('hex');
    const response = await requestWebhook(
      target,
      {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-gantry-webhook-id': String(event.eventId),
        'x-gantry-webhook-timestamp': timestamp,
        'x-gantry-webhook-event': event.eventType,
        'x-gantry-webhook-signature': signature,
        ...(event.correlationId
          ? { 'x-gantry-correlation-id': event.correlationId }
          : {}),
      },
      body,
    );
    if (response.ok) {
      await control.markWebhookDeliveryDelivered(delivery.deliveryId);
      return;
    }
    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    if (!retryable || attemptCount >= 5) {
      await control.markWebhookDeliveryDead(
        delivery.deliveryId,
        `Webhook request failed with status ${response.status}`,
      );
      return;
    }
    const nextAttemptAt = new Date(
      currentTimeMs() + Math.min(60_000, 1000 * 2 ** attemptCount),
    ).toISOString();
    await control.markWebhookDeliveryRetry({
      deliveryId: delivery.deliveryId,
      nextAttemptAt,
      lastError: `Webhook request failed with status ${response.status}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (attemptCount >= 5) {
      await control.markWebhookDeliveryDead(delivery.deliveryId, message);
    } else {
      const nextAttemptAt = new Date(
        currentTimeMs() + Math.min(60_000, 1000 * 2 ** attemptCount),
      ).toISOString();
      await control.markWebhookDeliveryRetry({
        deliveryId: delivery.deliveryId,
        nextAttemptAt,
        lastError: message,
      });
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index]!;
        index += 1;
        await worker(item);
      }
    },
  );
  await Promise.all(workers);
}

export async function flushWebhookDeliveries(): Promise<void> {
  await new PostgresEventBusOutboxConsumer(
    getRuntimeStorage().service.db,
  ).consume(WEBHOOK_DELIVERY_BATCH_SIZE);
  const control = getRuntimeControlRepository();
  const due = await control.claimDueWebhookDeliveries(
    WEBHOOK_DELIVERY_BATCH_SIZE,
  );
  await runWithConcurrency(
    due,
    WEBHOOK_DELIVERY_CONCURRENCY,
    deliverWebhookDelivery,
  );
}

export function logWebhookFlushFailure(error: unknown): void {
  logger.warn({ err: error }, 'Webhook delivery flush failed');
}
