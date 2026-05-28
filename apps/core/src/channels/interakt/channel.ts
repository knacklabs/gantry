import type { ChannelAdapter } from '../channel-provider.js';
import type {
  MessageDeliveryResult,
  MessageSendOptions,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';

import { InteraktApi } from './interakt-api.js';
import {
  INTERAKT_JID_PREFIX,
  interaktJidFromPhone,
  phoneFromInteraktJid,
} from './interakt-jid.js';
import {
  clearLiveInteraktChannel,
  setLiveInteraktChannel,
} from './interakt-instance-registry.js';

// 24-hour WhatsApp customer-service window. Outside this window WhatsApp
// Business API requires pre-approved templates; Phase 1 explicitly does
// not implement templates, so we surface a typed delivery error and let
// channel-wiring record it.
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InteraktChannelOpts {
  apiKey: string;
  webhookSecret: string;
  businessPhoneNumber: string;
  baseUrl: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  apiFactory?: (input: { baseUrl: string; apiKey: string }) => InteraktApi;
}

// Minimal narrow types matching documented Interakt webhook payloads.
interface InteraktInboundCustomer {
  channel_phone_number?: string;
  traits?: Record<string, unknown>;
}

interface InteraktInboundMessage {
  id?: string;
  chat_message_type?: string;
  message_content_type?: string;
  message?: string;
  media_url?: string | null;
  received_at_utc?: string;
}

interface InteraktInboundData {
  customer?: InteraktInboundCustomer;
  message?: InteraktInboundMessage;
}

interface InteraktWebhookEvent {
  version?: string;
  timestamp?: string;
  type?: string;
  data?: InteraktInboundData;
}

export class InteraktChannel implements ChannelAdapter {
  readonly name = 'interakt';

  private connected = false;
  private readonly api: InteraktApi;
  private readonly webhookSecret: string;
  // Phase 1: in-memory map. Cleared on restart — acceptable because we also
  // drop out-of-window sends (operator restart pauses outbound until the
  // customer messages again, which is the WhatsApp policy anyway).
  private readonly lastInboundAtByJid = new Map<string, number>();
  private readonly verifiedPhoneByJid = new Map<string, string>();
  private readonly onMessage: OnInboundMessage;
  private readonly onChatMetadata: OnChatMetadata;

  constructor(opts: InteraktChannelOpts) {
    this.webhookSecret = opts.webhookSecret;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    const factory =
      opts.apiFactory ??
      ((input) =>
        new InteraktApi({ baseUrl: input.baseUrl, apiKey: input.apiKey }));
    this.api = factory({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
  }

  // --- ChannelLifecyclePort ----------------------------------------------
  async connect(): Promise<void> {
    setLiveInteraktChannel(this);
    this.connected = true;
    logger.info(
      { channel: this.name },
      'Interakt channel ready (inbound via webhook, outbound via HTTP API)',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    clearLiveInteraktChannel(this);
  }

  // --- ChannelOwnershipPort ----------------------------------------------
  ownsJid(jid: string): boolean {
    return jid.startsWith(INTERAKT_JID_PREFIX);
  }

  // --- MessageSink -------------------------------------------------------
  async sendMessage(
    jid: string,
    text: string,
    _options: MessageSendOptions = {},
  ): Promise<MessageDeliveryResult | void> {
    if (!this.connected) return;
    const parsed = phoneFromInteraktJid(jid);
    if (!parsed) {
      logger.warn({ jid }, 'InteraktChannel.sendMessage: unparseable JID');
      return;
    }
    const last = this.lastInboundAtByJid.get(jid);
    if (!last || Date.now() - last > SESSION_WINDOW_MS) {
      const err = new Error('WhatsApp 24h customer-service window closed');
      Object.assign(err, { code: 'session_window_closed' });
      throw err;
    }
    const { id } = await this.api.sendFreeFormText({
      countryCode: parsed.countryCode,
      phoneNumber: parsed.phoneNumber,
      message: text,
    });
    return { externalMessageId: id };
  }

  // --- Webhook surface (called by the HTTP route) ------------------------
  getWebhookSecret(): string {
    return this.webhookSecret;
  }

  async handleWebhookEvent(parsed: unknown): Promise<void> {
    const event = parsed as InteraktWebhookEvent;
    if (!event || typeof event !== 'object') {
      logger.debug({}, 'Interakt webhook: payload is not an object');
      return;
    }
    if (event.type !== 'message_received') {
      logger.debug({ type: event.type }, 'Interakt webhook: ignoring event');
      return;
    }
    const data = event.data;
    const message = data?.message;
    if (!message) {
      logger.debug(
        {},
        'Interakt webhook: message_received without data.message',
      );
      return;
    }
    if (message.chat_message_type !== 'CustomerMessage') {
      // BusinessMessage = echo of our own send. Ignored in Phase 1.
      logger.debug(
        { chat_message_type: message.chat_message_type },
        'Interakt webhook: ignoring non-CustomerMessage',
      );
      return;
    }
    if (message.message_content_type !== 'Text') {
      logger.debug(
        { message_content_type: message.message_content_type },
        'Interakt webhook: Phase 1 ignores non-Text messages',
      );
      return;
    }
    const customer = data?.customer;
    const phone = customer?.channel_phone_number;
    if (!phone) {
      logger.warn(
        {},
        'Interakt webhook: message_received without channel_phone_number',
      );
      return;
    }
    const jid = interaktJidFromPhone(phone);
    if (!jid) {
      logger.warn(
        { phone },
        'Interakt webhook: could not derive JID from phone',
      );
      return;
    }
    const nowMs = Date.now();
    this.lastInboundAtByJid.set(jid, nowMs);
    const e164 = `+${jid.slice(INTERAKT_JID_PREFIX.length)}`;
    this.verifiedPhoneByJid.set(jid, e164);

    const receivedAt = message.received_at_utc || new Date(nowMs).toISOString();
    const traitsName =
      typeof customer.traits?.['name'] === 'string'
        ? (customer.traits['name'] as string)
        : undefined;

    // Announce metadata first so chatIsGroup gets populated and
    // ensureConfiguredConversationRoute (channel-persistence-handlers.ts:58-75)
    // can treat this as a known DM.
    await this.onChatMetadata(
      jid,
      receivedAt,
      traitsName,
      this.name,
      /* isGroup */ false,
    );

    const inbound: NewMessage = {
      id: message.id ?? `${jid}:${nowMs}`,
      chat_jid: jid,
      provider: this.name,
      sender: phone,
      sender_name: traitsName || phone,
      content: message.message ?? '',
      timestamp: receivedAt,
      is_from_me: false,
      is_bot_message: false,
      external_message_id: message.id,
    };
    await this.onMessage(jid, inbound);
  }

  // Test helper — primes the session window without an inbound webhook.
  primeSessionWindowForTesting(jid: string, nowMs: number = Date.now()): void {
    this.lastInboundAtByJid.set(jid, nowMs);
  }
}
