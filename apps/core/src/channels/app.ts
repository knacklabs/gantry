import { createHash, randomUUID } from 'node:crypto';

import { logger } from '../infrastructure/logging/logger.js';
import type {
  MessageSendOptions,
  ProgressUpdateOptions,
  RichInteractionRequest,
  StreamingChunkOptions,
} from '../domain/types.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import { SessionInteractionModule } from '../application/sessions/session-interaction-module.js';
import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
} from '../adapters/storage/postgres/runtime-store.js';
import { adaptSessionControlPort } from '../control/server/session-control-port.js';
import { nowIso } from '../shared/time/datetime.js';
import { richFallbackText } from './rich-interaction.js';

function canonicalTextMetadata(text: string): {
  lengthChars: number;
  lengthBytes: number;
  hasContent: boolean;
  hasTruncatedContent: boolean;
  sha256: string;
} {
  const metadataContentWindowChars = 160;
  return {
    lengthChars: text.length,
    lengthBytes: Buffer.byteLength(text, 'utf8'),
    hasContent: text.trim().length > 0,
    hasTruncatedContent: text.length > metadataContentWindowChars,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

async function emitSessionEvent(
  chatJid: string,
  eventType: RuntimeEventType,
  payload: Record<string, unknown>,
): Promise<{ emitted: boolean; eventId?: number }> {
  const result = await createSessionInteractionModule().publishOutboundEvent({
    conversationJid: chatJid,
    eventType,
    payload,
  });
  if (!result.emitted) {
    logger.warn(
      { chatJid, eventType },
      'App channel event dropped without session',
    );
  }
  return result;
}

function createSessionInteractionModule(): SessionInteractionModule {
  return new SessionInteractionModule({
    control: adaptSessionControlPort(getRuntimeControlRepository()),
    ops: {} as never,
    repositories: {} as never,
    runtimeEvents: getRuntimeEventExchange(),
    now: () => nowIso() as never,
    createId: randomUUID,
    stableHash: (input) => createHash('sha256').update(input).digest('hex'),
  });
}

export async function createAppChannel(
  opts: ChannelOpts,
): Promise<ChannelAdapter> {
  const liveUxBindingGeneration = opts.liveUxBindingGeneration;
  const initialLiveUxBindingGeneration = liveUxBindingGeneration?.();
  const hasLiveUxBindingGeneration =
    Number.isSafeInteger(initialLiveUxBindingGeneration) &&
    Number(initialLiveUxBindingGeneration) >= 1;
  let connected = false;
  let disconnecting = false;
  let outboundSequence = 0;
  const outboundGeneration = randomUUID();
  const activeTypingTargets = new Map<
    string,
    { jid: string; threadId?: string }
  >();
  const liveUx: NonNullable<ChannelAdapter['liveUx']> = {
    typing: hasLiveUxBindingGeneration ? 'explicit' : 'none',
    reactions: 'none',
    canonicalTarget: (target) => ({
      key: `typing\n${target.jid}\n${target.threadId ?? ''}`,
    }),
  };

  const orderedEnvelope = (
    kind: string,
    generation: number | string = outboundGeneration,
  ) => ({
    generation,
    sequence: ++outboundSequence,
    kind,
    partIndex: 1,
    totalParts: 1,
  });

  const sendMessage = async (
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ): Promise<{ externalMessageId?: string }> => {
    const result = await emitSessionEvent(
      jid,
      RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      {
        text,
        threadId: options?.threadId ?? null,
        orderedEnvelope: orderedEnvelope('outbound'),
        canonicalText: canonicalTextMetadata(text),
      },
    );
    return result.eventId !== undefined
      ? { externalMessageId: String(result.eventId) }
      : {};
  };

  const channel: ChannelAdapter = {
    name: 'app',
    liveUx,
    async connect() {
      disconnecting = false;
      connected = true;
      liveUx.typing = liveUxBindingGeneration?.() ? 'explicit' : 'none';
    },
    isConnected() {
      return connected;
    },
    async disconnect() {
      if (disconnecting) return;
      disconnecting = true;
      liveUx.typing = 'none';
      const targets = [...activeTypingTargets.values()];
      // Terminal appends are best effort: a stuck durable write must not hold
      // producer teardown or its replacement. The old generation envelope
      // keeps any late settlement behind the successor producer.
      targets.forEach((target) => {
        void emitSessionEvent(target.jid, RUNTIME_EVENT_TYPES.SESSION_TYPING, {
          isTyping: false,
          threadId: target.threadId ?? null,
          orderedEnvelope: orderedEnvelope(
            'typing',
            Number(initialLiveUxBindingGeneration),
          ),
        }).catch((err) => {
          logger.warn(
            {
              err,
              jid: target.jid,
              threadId: target.threadId,
            },
            'App channel failed to end typing during producer shutdown',
          );
        });
      });
      activeTypingTargets.clear();
      connected = false;
    },
    ownsJid(jid: string) {
      return jid.startsWith('app:');
    },
    sendMessage,
    async sendStreamingChunk(
      jid: string,
      text: string,
      options?: StreamingChunkOptions,
    ): Promise<boolean> {
      const result = await emitSessionEvent(
        jid,
        RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING,
        {
          text,
          threadId: options?.threadId ?? null,
          done: options?.done === true,
          generation: options?.generation ?? null,
          orderedEnvelope: orderedEnvelope('streaming'),
          canonicalText: canonicalTextMetadata(text),
        },
      );
      return result.emitted;
    },
    resetStreaming(_jid: string, _options?: { threadId?: string }) {},
    async setTyping(
      jid: string,
      isTyping: boolean,
      options: { threadId?: string; signal?: AbortSignal } = {},
    ): Promise<void> {
      if (isTyping && disconnecting) return;
      const generation = liveUxBindingGeneration?.();
      if (!Number.isSafeInteger(generation) || Number(generation) < 1) return;
      const targetKey = `${jid}\n${options.threadId ?? ''}`;
      const target = {
        jid,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      };
      const activeTargetBeforePublish = activeTypingTargets.get(targetKey);
      if (isTyping) {
        // Record intent before publication so shutdown can fence a start that
        // is still waiting on the durable append.
        activeTypingTargets.set(targetKey, target);
      }
      // App event publication is deliberately not cancellation-fenced through
      // the notifier or Postgres transaction. orderedEnvelope is the consumer
      // fence: a late stale typing event may remain in the event log, but an
      // order-aware consumer never applies it over a newer typing state.
      try {
        await emitSessionEvent(jid, RUNTIME_EVENT_TYPES.SESSION_TYPING, {
          isTyping,
          threadId: options.threadId ?? null,
          orderedEnvelope: orderedEnvelope('typing', Number(generation)),
        });
        if (
          !isTyping &&
          activeTypingTargets.get(targetKey) === activeTargetBeforePublish
        ) {
          activeTypingTargets.delete(targetKey);
        }
      } catch (error) {
        if (isTyping && activeTypingTargets.get(targetKey) === target) {
          activeTypingTargets.delete(targetKey);
        }
        throw error;
      }
    },
    async sendProgressUpdate(
      jid: string,
      text: string,
      options?: ProgressUpdateOptions,
    ): Promise<boolean> {
      const result = await emitSessionEvent(
        jid,
        RUNTIME_EVENT_TYPES.SESSION_PROGRESS,
        {
          text,
          threadId: options?.threadId ?? null,
          done: options?.done === true,
          actionOnly: options?.actionOnly === true,
          actionAffordances: options?.done
            ? []
            : (options?.actionAffordances ?? []),
          orderedEnvelope: orderedEnvelope('progress'),
          canonicalText: canonicalTextMetadata(text),
        },
      );
      return result.emitted;
    },
    async renderRichInteraction(
      jid: string,
      render: RichInteractionRequest,
    ): Promise<boolean> {
      const fallbackText = richFallbackText(render);
      const result = await emitSessionEvent(
        jid,
        RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
        {
          kind: 'rich_interaction',
          descriptor: render.descriptor,
          fallbackText,
          threadId: render.threadId ?? null,
          orderedEnvelope: orderedEnvelope('rich_interaction'),
          canonicalText: canonicalTextMetadata(fallbackText),
        },
      );
      return result.emitted;
    },
  };
  return channel;
}
