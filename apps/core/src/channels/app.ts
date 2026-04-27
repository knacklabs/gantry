import { logger } from '../infrastructure/logging/logger.js';
import type {
  MessageSendOptions,
  ProgressUpdateOptions,
  StreamingChunkOptions,
} from '../domain/types.js';
import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import { getRuntimeControlRepository } from '../adapters/storage/postgres/runtime-store.js';

async function emitSessionEvent(
  chatJid: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const control = getRuntimeControlRepository();
  const session = await control.getAppSessionByChatJid(chatJid);
  if (!session) {
    logger.warn(
      { chatJid, eventType },
      'App channel event dropped without session',
    );
    return false;
  }
  const threadId =
    typeof payload.threadId === 'string' ? payload.threadId : null;
  const route = await control.getAppResponseRoute({
    sessionId: session.sessionId,
    threadId,
  });
  await control.addControlEvent({
    eventType,
    payload: JSON.stringify(payload),
    actor: 'agent',
    sessionId: session.sessionId,
    correlationId: route?.correlationId ?? null,
    responseMode: route?.responseMode ?? session.defaultResponseMode,
    webhookId: route ? route.webhookId : session.defaultWebhookId,
  });
  return true;
}

export async function createAppChannel(
  _opts: ChannelOpts,
): Promise<ChannelAdapter> {
  let connected = false;

  const sendMessage = async (
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ): Promise<void> => {
    await emitSessionEvent(jid, 'session.message.outbound', {
      text,
      threadId: options?.threadId ?? null,
    });
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
      return emitSessionEvent(jid, 'session.message.streaming', {
        text,
        threadId: options?.threadId ?? null,
        done: options?.done === true,
        generation: options?.generation ?? null,
      });
    },
    resetStreaming(_jid: string) {},
    async setTyping(jid: string, isTyping: boolean): Promise<void> {
      await emitSessionEvent(jid, 'session.typing', { isTyping });
    },
    async sendProgressUpdate(
      jid: string,
      text: string,
      options?: ProgressUpdateOptions,
    ): Promise<void> {
      await emitSessionEvent(jid, 'session.progress', {
        text,
        threadId: options?.threadId ?? null,
        done: options?.done === true,
      });
    },
  };
}
