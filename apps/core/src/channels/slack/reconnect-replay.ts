import type { App } from '@slack/bolt';

import type {
  ConversationIngressRecovery,
  ConversationIngressRecoveryTarget,
} from '../../domain/ports/conversation-ingress-cursor.js';
import type { SlackMessageLike } from './message-shapes.js';
import { logger } from '../../infrastructure/logging/logger.js';

const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const REPLAY_BATCH_SIZE = 500;
const REPLAY_RETRY_MIN_MS = 5_000;
const REPLAY_RETRY_MAX_MS = 5 * 60_000;

type HistoryMessage = SlackMessageLike & {
  latest_reply?: string;
  reply_count?: number;
};

function slackTimestamp(iso: string): string {
  return (new Date(iso).getTime() / 1_000).toFixed(6);
}

function isoTimestamp(slackTs: string): string {
  return new Date(Number(slackTs) * 1_000).toISOString();
}

function laterTimestamp(...values: string[]): string {
  return values.reduce((latest, value) =>
    new Date(value).getTime() > new Date(latest).getTime() ? value : latest,
  );
}

function nextCursor(response: unknown): string | undefined {
  const cursor = (
    response as { response_metadata?: { next_cursor?: string } }
  ).response_metadata?.next_cursor?.trim();
  return cursor || undefined;
}

async function listHistory(input: {
  app: App;
  channel: string;
  oldest: string;
  latest: string;
}): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
  let cursor: string | undefined;
  do {
    const response = (await input.app.client.conversations.history({
      channel: input.channel,
      oldest: input.oldest,
      latest: input.latest,
      inclusive: false,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as { messages?: HistoryMessage[] };
    messages.push(...(response.messages ?? []));
    cursor = nextCursor(response);
  } while (cursor);
  return messages;
}

async function listThreadReplies(input: {
  app: App;
  channel: string;
  threadTs: string;
  oldest: string;
  latest: string;
}): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
  let cursor: string | undefined;
  do {
    const response = (await input.app.client.conversations.replies({
      channel: input.channel,
      ts: input.threadTs,
      oldest: input.oldest,
      latest: input.latest,
      inclusive: false,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as { messages?: HistoryMessage[] };
    messages.push(...(response.messages ?? []));
    cursor = nextCursor(response);
  } while (cursor);
  return messages;
}

async function recoverTarget(input: {
  app: App;
  recovery: ConversationIngressRecovery;
  target: ConversationIngressRecoveryTarget;
  reconnectAt: string;
  ingest: (message: SlackMessageLike) => Promise<void>;
}): Promise<void> {
  const cursor = await input.recovery.getCursor(input.target);
  const windowFloor = new Date(
    new Date(input.reconnectAt).getTime() - REPLAY_WINDOW_MS,
  ).toISOString();
  const startedAt = laterTimestamp(
    input.target.installedAt,
    windowFloor,
    cursor?.coveredThroughTimestamp ?? windowFloor,
  );
  await input.recovery.publish({
    target: input.target,
    eventType: 'channel.replay.started',
    payload: { startedAt, highWaterAt: input.reconnectAt },
  });

  try {
    const oldest = slackTimestamp(startedAt);
    const latest = slackTimestamp(input.reconnectAt);
    const parents = await listHistory({
      app: input.app,
      channel: input.target.externalConversationId,
      oldest,
      latest,
    });
    const messages = [...parents];
    for (const parent of parents) {
      if (
        !parent.ts ||
        !parent.reply_count ||
        !parent.latest_reply ||
        Number(parent.latest_reply) <= Number(oldest)
      ) {
        continue;
      }
      messages.push(
        ...(await listThreadReplies({
          app: input.app,
          channel: input.target.externalConversationId,
          threadTs: parent.ts,
          oldest,
          latest,
        })),
      );
    }

    const ordered = [
      ...new Map(
        messages
          .filter(
            (message): message is HistoryMessage & { ts: string } =>
              Boolean(message.ts) &&
              Number(message.ts) > Number(oldest) &&
              Number(message.ts) <= Number(latest),
          )
          .map((message) => [message.ts, message]),
      ).values(),
    ].sort((left, right) => Number(left.ts) - Number(right.ts));

    let version = cursor?.version ?? 0;
    let coveredThroughExternalId = cursor?.coveredThroughExternalId;
    for (let offset = 0; offset < ordered.length; offset += REPLAY_BATCH_SIZE) {
      const batch = ordered.slice(offset, offset + REPLAY_BATCH_SIZE);
      for (const message of batch) {
        await input.ingest({
          ...message,
          channel: input.target.externalConversationId,
        });
      }
      const last = batch.at(-1);
      if (!last) continue;
      const advanced = await input.recovery.advanceCursor({
        target: input.target,
        expectedVersion: version,
        coveredThroughExternalId: last.ts,
        coveredThroughTimestamp: isoTimestamp(last.ts),
      });
      if (advanced === 'stale') return;
      version += 1;
      coveredThroughExternalId = last.ts;
    }
    const advanced = await input.recovery.advanceCursor({
      target: input.target,
      expectedVersion: version,
      coveredThroughExternalId,
      coveredThroughTimestamp: input.reconnectAt,
    });
    if (advanced === 'stale') return;
    await input.recovery.publish({
      target: input.target,
      eventType: 'channel.replay.completed',
      payload: {
        startedAt,
        highWaterAt: input.reconnectAt,
        observedCount: ordered.length,
      },
    });
  } catch (error) {
    await input.recovery.publish({
      target: input.target,
      eventType: 'channel.replay.failed',
      payload: {
        startedAt,
        highWaterAt: input.reconnectAt,
        error: error instanceof Error ? error.name : 'UnknownError',
      },
    });
    throw error;
  }
}

export async function recoverSlackIngress(input: {
  app: App;
  providerAccountId: string;
  recovery: ConversationIngressRecovery;
  ingest: (message: SlackMessageLike) => Promise<void>;
}): Promise<void> {
  const reconnectAt = new Date().toISOString();
  const targets = await input.recovery.listTargets(input.providerAccountId);
  for (const target of targets) {
    await recoverTarget({ ...input, target, reconnectAt });
  }
}

export function slackRetryAfterMs(error: unknown): number | undefined {
  const seconds = Number(
    (error as { retryAfter?: number; data?: { retry_after?: number } })
      ?.retryAfter ??
      (error as { data?: { retry_after?: number } })?.data?.retry_after,
  );
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
}

export function createSlackIngressReplayScheduler(input: {
  app: () => App | null;
  providerAccountId: string;
  recovery: ConversationIngressRecovery;
  ingest: (message: SlackMessageLike) => Promise<void>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let generation = 0;
  let running = false;
  let queued = false;
  let queuedDelayMs = 0;

  const schedule = (delayMs = 0): void => {
    if (!input.app() || timer) return;
    if (running) {
      queued = true;
      queuedDelayMs = Math.max(queuedDelayMs, delayMs);
      return;
    }
    const scheduledGeneration = generation;
    timer = setTimeout(() => {
      timer = null;
      const app = input.app();
      if (scheduledGeneration !== generation || !app) return;
      running = true;
      void recoverSlackIngress({ ...input, app })
        .then(() => {
          attempt = 0;
        })
        .catch((error) => {
          if (scheduledGeneration !== generation) return;
          const retryMs = Math.min(
            REPLAY_RETRY_MAX_MS,
            Math.max(
              slackRetryAfterMs(error) ?? 0,
              REPLAY_RETRY_MIN_MS * 2 ** attempt,
            ),
          );
          attempt += 1;
          logger.warn(
            { err: error, providerAccountId: input.providerAccountId, retryMs },
            'Slack reconnect replay failed; retrying while connected',
          );
          queued = true;
          queuedDelayMs = retryMs;
        })
        .finally(() => {
          running = false;
          if (!queued || scheduledGeneration !== generation) return;
          const delay = queuedDelayMs;
          queued = false;
          queuedDelayMs = 0;
          schedule(delay);
        });
    }, delayMs);
    timer.unref?.();
  };

  return {
    schedule,
    stop() {
      generation += 1;
      attempt = 0;
      queued = false;
      queuedDelayMs = 0;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
