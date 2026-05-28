import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getProvider,
  providerForJid,
} from '@core/channels/provider-registry.js';
import '@core/channels/register-builtins.js';
import {
  InteraktChannel,
  type InteraktChannelOpts,
} from '@core/channels/interakt/channel.js';
import {
  INTERAKT_JID_PREFIX,
  interaktJidFromPhone,
  isInteraktJid,
  phoneFromInteraktJid,
} from '@core/channels/interakt/interakt-jid.js';
import {
  InteraktApi,
  InteraktRateLimitError,
} from '@core/channels/interakt/interakt-api.js';
import { formatOutboundForChannel } from '@core/messaging/router.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

describe('Interakt provider registration', () => {
  it('registers with id "interakt" and jidPrefix "wa:"', () => {
    const provider = getProvider('interakt');
    expect(provider).toBeDefined();
    expect(provider?.id).toBe('interakt');
    expect(provider?.jidPrefix).toBe(INTERAKT_JID_PREFIX);
    expect(provider?.formatting).toBe('telegram-html');
  });

  it('claims wa:* JIDs via providerForJid', () => {
    expect(providerForJid('wa:917003705584')?.id).toBe('interakt');
  });

  it('reports DMs only (isGroupJid always false)', () => {
    const provider = getProvider('interakt')!;
    expect(provider.isGroupJid('wa:917003705584')).toBe(false);
  });

  it('omits canStreamToJid (no streaming on WhatsApp)', () => {
    const provider = getProvider('interakt')!;
    expect(provider.canStreamToJid).toBeUndefined();
  });
});

describe('Interakt JID helpers', () => {
  it('normalises phone input', () => {
    expect(interaktJidFromPhone('917003705584')).toBe('wa:917003705584');
    expect(interaktJidFromPhone('+91 70037 05584')).toBe('wa:917003705584');
    expect(interaktJidFromPhone('+91-70037-05584')).toBe('wa:917003705584');
  });

  it('rejects non-numeric or out-of-range input', () => {
    expect(interaktJidFromPhone('abc')).toBeNull();
    expect(interaktJidFromPhone('123')).toBeNull(); // too short
    expect(interaktJidFromPhone('1'.repeat(20))).toBeNull(); // too long
  });

  it('isInteraktJid detects the prefix', () => {
    expect(isInteraktJid('wa:917003705584')).toBe(true);
    expect(isInteraktJid('sl:C12345')).toBe(false);
  });

  it('phoneFromInteraktJid splits country code and number', () => {
    expect(phoneFromInteraktJid('wa:917003705584')).toEqual({
      countryCode: '91',
      phoneNumber: '7003705584',
    });
    expect(phoneFromInteraktJid('wa:14155551234')).toEqual({
      countryCode: '1',
      phoneNumber: '4155551234',
    });
    // 3-digit prefix (Indonesia neighbouring Latvia at +371)
    expect(phoneFromInteraktJid('wa:37120000001')).toEqual({
      countryCode: '371',
      phoneNumber: '20000001',
    });
  });

  it('returns null for non-Interakt JIDs', () => {
    expect(phoneFromInteraktJid('sl:C123')).toBeNull();
  });
});

// --- Channel runtime tests ----------------------------------------------

interface MockFetchResult {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
}

function makeMockFetch(response: {
  status?: number;
  body?: unknown;
  retryAfter?: string;
}): MockFetchResult {
  const calls: MockFetchResult['calls'] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    let parsed: Record<string, unknown> = {};
    if (init?.body) {
      parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
    }
    calls.push({ url, body: parsed });
    const status = response.status ?? 200;
    const headers = new Headers(
      response.retryAfter ? { 'retry-after': response.retryAfter } : {},
    );
    return new Response(
      typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body ?? { result: true, id: 'mock-id' }),
      { status, headers },
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function makeChannel(
  opts: {
    fetchImpl?: typeof fetch;
    onMessage?: InteraktChannelOpts['onMessage'];
    onChatMetadata?: InteraktChannelOpts['onChatMetadata'];
  } = {},
): InteraktChannel {
  return new InteraktChannel({
    apiKey: 'TEST_KEY_BASE64==',
    webhookSecret: 'webhook_secret',
    businessPhoneNumber: '917003705584',
    baseUrl: 'https://api.test.interakt',
    onMessage: opts.onMessage ?? vi.fn(async () => undefined),
    onChatMetadata: opts.onChatMetadata ?? vi.fn(async () => undefined),
    apiFactory: ({ baseUrl, apiKey }) =>
      new InteraktApi({
        baseUrl,
        apiKey,
        fetchImpl: opts.fetchImpl ?? makeMockFetch({}).fetch,
      }),
  });
}

describe('InteraktChannel inbound', () => {
  let onMessage: ReturnType<typeof vi.fn>;
  let onChatMetadata: ReturnType<typeof vi.fn>;
  let channel: InteraktChannel;

  beforeEach(async () => {
    onMessage = vi.fn(async () => undefined);
    onChatMetadata = vi.fn(async () => undefined);
    channel = makeChannel({ onMessage, onChatMetadata });
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  it('ingests a text CustomerMessage and delivers a NewMessage', async () => {
    await channel.handleWebhookEvent({
      version: '1.0',
      timestamp: '2026-05-20T10:00:00Z',
      type: 'message_received',
      data: {
        customer: {
          channel_phone_number: '917003705584',
          traits: { name: 'Test User' },
        },
        message: {
          id: 'msg-1',
          chat_message_type: 'CustomerMessage',
          message_content_type: 'Text',
          message: 'hello',
          received_at_utc: '2026-05-20T10:00:00Z',
        },
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = onMessage.mock.calls[0]!;
    expect(jid).toBe('wa:917003705584');
    expect(msg).toMatchObject({
      provider: 'interakt',
      chat_jid: 'wa:917003705584',
      sender: '917003705584',
      sender_name: 'Test User',
      content: 'hello',
      is_from_me: false,
      external_message_id: 'msg-1',
    });

    expect(onChatMetadata).toHaveBeenCalledWith(
      'wa:917003705584',
      '2026-05-20T10:00:00Z',
      'Test User',
      'interakt',
      false,
    );
  });

  it('ignores BusinessMessage (echo of our own send)', async () => {
    await channel.handleWebhookEvent({
      type: 'message_received',
      data: {
        customer: { channel_phone_number: '917003705584' },
        message: {
          id: 'b-1',
          chat_message_type: 'BusinessMessage',
          message_content_type: 'Text',
          message: 'we replied',
        },
      },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores non-Text content types (Phase 1 supports text only)', async () => {
    await channel.handleWebhookEvent({
      type: 'message_received',
      data: {
        customer: { channel_phone_number: '917003705584' },
        message: {
          id: 'i-1',
          chat_message_type: 'CustomerMessage',
          message_content_type: 'Image',
          media_url: 'https://example.com/photo.jpg',
        },
      },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores unknown event types', async () => {
    await channel.handleWebhookEvent({ type: 'message_api_delivered' });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores malformed events without throwing', async () => {
    await channel.handleWebhookEvent(null);
    await channel.handleWebhookEvent({ type: 'message_received' });
    await channel.handleWebhookEvent({
      type: 'message_received',
      data: { customer: {}, message: { chat_message_type: 'CustomerMessage' } },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('InteraktChannel outbound', () => {
  it('sends free-form text within the 24h window', async () => {
    const mock = makeMockFetch({ body: { result: true, id: 'wa-msg-7' } });
    const channel = makeChannel({ fetchImpl: mock.fetch });
    await channel.connect();
    // Prime the inbound timestamp so the session window is open.
    channel.primeSessionWindowForTesting('wa:917003705584');

    const result = await channel.sendMessage('wa:917003705584', 'hi back');
    expect(result).toEqual({ externalMessageId: 'wa-msg-7' });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toContain('/public/message/');
    expect(mock.calls[0]!.body).toMatchObject({
      countryCode: '91',
      phoneNumber: '7003705584',
      type: 'Text',
      data: { message: 'hi back' },
    });

    await channel.disconnect();
  });

  it('throws session_window_closed when no inbound is recorded', async () => {
    const mock = makeMockFetch({});
    const channel = makeChannel({ fetchImpl: mock.fetch });
    await channel.connect();

    await expect(
      channel.sendMessage('wa:917003705584', 'hello'),
    ).rejects.toMatchObject({
      code: 'session_window_closed',
    });
    expect(mock.calls).toHaveLength(0);
    await channel.disconnect();
  });

  it('throws session_window_closed when last inbound is older than 24h', async () => {
    const mock = makeMockFetch({});
    const channel = makeChannel({ fetchImpl: mock.fetch });
    await channel.connect();
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    channel.primeSessionWindowForTesting('wa:917003705584', twentyFiveHoursAgo);

    await expect(
      channel.sendMessage('wa:917003705584', 'hi'),
    ).rejects.toMatchObject({
      code: 'session_window_closed',
    });
    expect(mock.calls).toHaveLength(0);
    await channel.disconnect();
  });

  it('maps 429 to InteraktRateLimitError', async () => {
    const mock = makeMockFetch({ status: 429, retryAfter: '5', body: '' });
    const channel = makeChannel({ fetchImpl: mock.fetch });
    await channel.connect();
    channel.primeSessionWindowForTesting('wa:917003705584');

    await expect(
      channel.sendMessage('wa:917003705584', 'x'),
    ).rejects.toBeInstanceOf(InteraktRateLimitError);
    await channel.disconnect();
  });

  it('maps non-2xx to a generic error', async () => {
    const mock = makeMockFetch({ status: 500, body: '<html>500</html>' });
    const channel = makeChannel({ fetchImpl: mock.fetch });
    await channel.connect();
    channel.primeSessionWindowForTesting('wa:917003705584');

    await expect(channel.sendMessage('wa:917003705584', 'x')).rejects.toThrow(
      /HTTP 500/,
    );
    await channel.disconnect();
  });

  it('maps result:false to a generic error carrying Interakt message', async () => {
    const mock = makeMockFetch({
      body: { result: false, message: 'invalid recipient' },
    });
    const channel = makeChannel({ fetchImpl: mock.fetch });
    await channel.connect();
    channel.primeSessionWindowForTesting('wa:917003705584');

    await expect(channel.sendMessage('wa:917003705584', 'x')).rejects.toThrow(
      /invalid recipient/,
    );
    await channel.disconnect();
  });

  it('ownsJid returns true for wa: and false for others', async () => {
    const channel = makeChannel({});
    await channel.connect();
    expect(channel.ownsJid('wa:917003705584')).toBe(true);
    expect(channel.ownsJid('sl:C123')).toBe(false);
    await channel.disconnect();
  });
});

describe('WhatsApp formatting dialect', () => {
  it('keeps markdown bold/italic as WhatsApp single-asterisk/underscore', () => {
    expect(formatOutboundForChannel('**hi** *world*', 'interakt')).toBe(
      '*hi* _world_',
    );
  });

  it('flattens markdown links to label (url)', () => {
    expect(
      formatOutboundForChannel('[click here](https://example.com)', 'interakt'),
    ).toBe('click here (https://example.com)');
  });

  it('leaves strikethrough markdown unchanged in the provider-neutral formatter', () => {
    expect(formatOutboundForChannel('~~gone~~', 'interakt')).toBe('~~gone~~');
  });

  it('preserves fenced code blocks untouched', () => {
    const input = '```\nconst x = 1;\n```';
    expect(formatOutboundForChannel(input, 'interakt')).toBe(input);
  });

  it('reduces headings to single-asterisk bold', () => {
    expect(formatOutboundForChannel('# Heading', 'interakt')).toBe('*Heading*');
  });
});
