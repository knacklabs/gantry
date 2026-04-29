import { logger } from '../infrastructure/logging/logger.js';
import type {
  MessageSendOptions,
  ProgressUpdateOptions,
  StreamingChunkOptions,
} from '../domain/types.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
} from '../adapters/storage/postgres/runtime-store.js';

async function emitSessionEvent(
  chatJid: string,
  eventType: RuntimeEventType,
  payload: Record<string, unknown>,
): Promise<{ emitted: boolean; eventId?: number }> {
  const control = getRuntimeControlRepository();
  const session = await control.getAppSessionByChatJid(chatJid);
  if (!session) {
    logger.warn(
      { chatJid, eventType },
      'App channel event dropped without session',
    );
    return { emitted: false };
  }
  const threadId =
    typeof payload.threadId === 'string' ? payload.threadId : null;
  const route = await control.getAppResponseRoute({
    sessionId: session.sessionId,
    threadId,
  });
  const event = await getRuntimeEventExchange().publish({
    appId: session.appId as never,
    eventType,
    payload,
    actor: 'agent',
    sessionId: session.sessionId as never,
    correlationId: route?.correlationId ?? null,
    responseMode: route?.responseMode ?? session.defaultResponseMode,
    webhookId: route ? route.webhookId : session.defaultWebhookId,
  });
  return { emitted: true, eventId: event.eventId };
}

export async function createAppChannel(
  _opts: ChannelOpts,
): Promise<ChannelAdapter> {
  let connected = false;

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
      },
    );
    return result.eventId !== undefined
      ? { externalMessageId: String(result.eventId) }
      : {};
  };

  return {
    name: 'app',
    async connect() {
      connected = true;
    },
    isConnected() {
      return connected;
    },
    async disconnect() {
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
        },
      );
      return result.emitted;
    },
    resetStreaming(_jid: string) {},
    async setTyping(jid: string, isTyping: boolean): Promise<void> {
      await emitSessionEvent(jid, RUNTIME_EVENT_TYPES.SESSION_TYPING, {
        isTyping,
      });
    },
    async sendProgressUpdate(
      jid: string,
      text: string,
      options?: ProgressUpdateOptions,
    ): Promise<void> {
      await emitSessionEvent(jid, RUNTIME_EVENT_TYPES.SESSION_PROGRESS, {
        text,
        threadId: options?.threadId ?? null,
        done: options?.done === true,
      });
    },
  };
}
