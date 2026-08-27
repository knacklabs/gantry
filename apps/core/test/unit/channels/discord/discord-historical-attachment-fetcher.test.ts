import { describe, expect, it, vi } from 'vitest';

import {
  fetchDiscordCdnAttachment,
  fetchDiscordHistoricalAttachment,
} from '@core/channels/discord/historical-attachment-fetcher.js';
import {
  DiscordRestError,
  requestDiscordJson,
} from '@core/channels/discord/http-helpers.js';

const identity = {
  provider: 'discord',
  kind: 'attachment_id',
  id: 'attachment-1',
  channelId: 'thread-1',
  messageId: 'message-1',
  parentChannelId: 'channel-1',
};
const scope = { conversationJid: 'dc:channel-1', threadId: 'thread-1' };

describe('Discord historical attachment fetch', () => {
  it.each([
    [{ ...identity, provider: 'slack' }, scope],
    [{ ...identity, kind: 'file_id' }, scope],
    [{ ...identity, id: '' }, scope],
    [{ ...identity, messageId: ' ' }, scope],
    [{ ...identity, channelId: '' }, scope],
    [{ ...identity, parentChannelId: '' }, scope],
    [
      {
        provider: 'discord',
        kind: 'attachment_id',
        id: 'attachment-1',
        channelId: 'thread-1',
        messageId: 'message-1',
      },
      scope,
    ],
    [{ ...identity, messageId: '' }, scope],
    [identity, { conversationJid: 'dc:other-channel' }],
    [identity, { conversationJid: 'dc:other-channel', threadId: 'thread-1' }],
    [identity, { conversationJid: 'sl:C123', threadId: 'thread-1' }],
    [identity, { conversationJid: 'dc:channel-1', threadId: 'other-thread' }],
  ])(
    'rejects invalid or foreign identity before provider I/O',
    async (candidateIdentity, candidateScope) => {
      const requestMessage = vi.fn();
      const download = vi.fn();

      await expect(
        fetchDiscordHistoricalAttachment(
          { identity: candidateIdentity, ...candidateScope },
          { requestMessage, download },
        ),
      ).resolves.toEqual({ status: 'unreachable', reason: 'incapable' });
      expect(requestMessage).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    },
  );

  it('looks up the durable attachment identity and returns a safe CDN stream', async () => {
    const requestMessage = vi.fn(async () => ({
      id: 'message-1',
      channel_id: 'thread-1',
      attachments: [
        {
          id: 'attachment-1',
          filename: 'report.txt',
          content_type: 'text/plain',
          url: 'https://cdn.discordapp.com/attachments/1/report.txt',
        },
      ],
    }));
    const download = vi.fn(async () => new Response('historical bytes'));

    const result = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      { requestMessage, download },
    );

    expect(requestMessage).toHaveBeenCalledWith(
      'thread-1',
      'message-1',
      undefined,
    );
    expect(download).toHaveBeenCalledWith(
      'https://cdn.discordapp.com/attachments/1/report.txt',
      undefined,
    );
    expect(result).toMatchObject({
      status: 'ok',
      fileName: 'report.txt',
      contentType: 'text/plain',
    });
    if (result.status !== 'ok' || !('read' in result.content)) {
      throw new Error('expected streaming Discord content');
    }
    expect(
      Buffer.from((await result.content.read()).value ?? []).toString('utf8'),
    ).toBe('historical bytes');
  });

  it('uses only the fresh message lookup URL and ignores caller identity extensions', async () => {
    const requestMessage = vi.fn(async () => ({
      attachments: [
        {
          id: 'attachment-1',
          url: 'https://cdn.discordapp.com/attachments/fresh/report.txt',
        },
      ],
    }));
    const download = vi.fn(async () => new Response('fresh'));

    await fetchDiscordHistoricalAttachment(
      {
        identity: {
          ...identity,
          url: 'https://cdn.discordapp.com/attachments/expired/report.txt',
        },
        ...scope,
      },
      { requestMessage, download },
    );

    expect(download).toHaveBeenCalledWith(
      'https://cdn.discordapp.com/attachments/fresh/report.txt',
      undefined,
    );
  });

  it('allows only the Discord CDN and strips credentials and REST headers on every hop', async () => {
    const redirectCancel = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({ cancel: redirectCancel }),
          {
            status: 302,
            headers: {
              location:
                'https://cdn.discordapp.com/attachments/1/redirected.txt',
            },
          },
        ),
      )
      .mockResolvedValueOnce(new Response('ok'));

    const response = await fetchDiscordCdnAttachment(
      'https://cdn.discordapp.com/attachments/1/report.txt',
      undefined,
      fetcher,
    );

    expect(response.ok).toBe(true);
    expect(redirectCancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
      });
      expect(init).not.toHaveProperty('headers');
    }
  });

  it.each([
    'http://cdn.discordapp.com/attachments/1/report.txt',
    'https://cdn.discordapp.com:444/attachments/1/report.txt',
    'https://discordapp.com/attachments/1/report.txt',
    'https://cdn.discordapp.com.evil.test/attachments/1/report.txt',
  ])('rejects unsafe initial CDN URL %s without a request', async (url) => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      fetchDiscordCdnAttachment(url, undefined, fetcher),
    ).rejects.toThrow('Unsafe Discord CDN URL');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a foreign redirect with zero second-hop calls', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 302,
        headers: { location: 'https://evil.test/stolen' },
      }),
    );

    await expect(
      fetchDiscordCdnAttachment(
        'https://cdn.discordapp.com/attachments/1/report.txt',
        undefined,
        fetcher,
      ),
    ).rejects.toThrow('Unsafe Discord CDN URL');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a non-OK final CDN response body', async () => {
    const cancel = vi.fn();
    const result = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      {
        requestMessage: vi.fn(async () => ({
          attachments: [
            {
              id: 'attachment-1',
              url: 'https://cdn.discordapp.com/attachments/1/report.bin',
            },
          ],
        })),
        download: vi.fn(
          async () =>
            new Response(new ReadableStream<Uint8Array>({ cancel }), {
              status: 503,
            }),
        ),
      },
    );

    expect(result).toEqual({ status: 'unreachable', reason: 'unknown' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('propagates cancellation to the CDN response body', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      }),
    );
    const result = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      {
        requestMessage: vi.fn(async () => ({
          attachments: [
            {
              id: 'attachment-1',
              filename: 'report.bin',
              url: 'https://cdn.discordapp.com/attachments/1/report.bin',
            },
          ],
        })),
        download: vi.fn(async () => response),
      },
    );
    if (result.status !== 'ok' || !('read' in result.content)) {
      throw new Error('expected streaming Discord content');
    }

    await result.content.cancel('too_large');

    expect(cancel).toHaveBeenCalledWith('too_large');
  });

  it('cancels a pending CDN body read when the request is aborted', async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const result = await fetchDiscordHistoricalAttachment(
      { identity, ...scope, signal: controller.signal },
      {
        requestMessage: vi.fn(async () => ({
          attachments: [
            {
              id: 'attachment-1',
              url: 'https://cdn.discordapp.com/attachments/1/report.bin',
            },
          ],
        })),
        download: vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                pull() {},
                cancel,
              }),
            ),
        ),
      },
    );
    if (result.status !== 'ok' || !('read' in result.content)) {
      throw new Error('expected streaming Discord content');
    }
    const read = result.content.read();

    controller.abort(new DOMException('stopped', 'AbortError'));

    await expect(read).resolves.toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledWith(controller.signal.reason);
  });

  it('treats only Discord unknown-message or a missing id in a non-empty attachment list as deleted', async () => {
    const unknownMessage = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      {
        requestMessage: vi.fn(async () => {
          throw new DiscordRestError('missing', 404, 10008);
        }),
        download: vi.fn(),
      },
    );
    const redactedAttachments = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      {
        requestMessage: vi.fn(async () => ({ attachments: [] })),
        download: vi.fn(),
      },
    );
    const missingAttachment = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      {
        requestMessage: vi.fn(async () => ({
          attachments: [{ id: 'another-attachment' }],
        })),
        download: vi.fn(),
      },
    );

    expect(unknownMessage).toEqual({ status: 'deleted' });
    expect(redactedAttachments).toEqual({
      status: 'unreachable',
      reason: 'not_visible',
    });
    expect(missingAttachment).toEqual({ status: 'deleted' });
  });

  it.each([
    {},
    { attachments: [null] },
    { attachments: [{}] },
    { attachments: [{ id: 1 }] },
  ])('keeps malformed successful message body %# unreachable', async (body) => {
    const download = vi.fn();
    const result = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      {
        requestMessage: vi.fn(async () => body as never),
        download,
      },
    );

    expect(result).toEqual({ status: 'unreachable', reason: 'unknown' });
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    { flags: 64 },
    { attachments: [{ id: 'attachment-1', ephemeral: true }] },
  ])('never downloads ephemeral live content', async (message) => {
    const download = vi.fn();
    const result = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      {
        requestMessage: vi.fn(async () => ({
          attachments: [
            {
              id: 'attachment-1',
              url: 'https://cdn.discordapp.com/attachments/1/report.bin',
            },
          ],
          ...message,
        })),
        download,
      },
    );

    expect(result).toEqual({ status: 'unreachable', reason: 'not_visible' });
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    [new DiscordRestError('bare 404', 404), 'unknown'],
    [new DiscordRestError('auth', 401, 50014), 'auth'],
    [new DiscordRestError('rate limit', 429, 0), 'rate_limit'],
    [new SyntaxError('malformed JSON'), 'unknown'],
    [new DOMException('aborted', 'AbortError'), 'network'],
    [new TypeError('network failed'), 'network'],
  ] as const)(
    'keeps non-authoritative failure unreachable',
    async (error, reason) => {
      const result = await fetchDiscordHistoricalAttachment(
        { identity, ...scope },
        {
          requestMessage: vi.fn(async () => {
            throw error;
          }),
          download: vi.fn(),
        },
      );

      expect(result).toEqual({ status: 'unreachable', reason });
    },
  );

  it('keeps an ambiguous CDN 404 unreachable and non-deleting', async () => {
    const result = await fetchDiscordHistoricalAttachment(
      { identity, ...scope },
      {
        requestMessage: vi.fn(async () => ({
          attachments: [
            {
              id: 'attachment-1',
              url: 'https://cdn.discordapp.com/attachments/1/report.bin',
            },
          ],
        })),
        download: vi.fn(async () => new Response('{}', { status: 404 })),
      },
    );

    expect(result).toEqual({ status: 'unreachable', reason: 'unknown' });
  });
});

describe('Discord REST status helper', () => {
  it('retains 429 retry and preserves final HTTP status and Discord code', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 20028 }), {
          status: 429,
          headers: { 'retry-after': '0.001' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 50001 }), { status: 403 }),
      );

    const request = requestDiscordJson({
      url: 'https://discord.com/api/v10/test',
      init: { signal: new AbortController().signal },
      errorMessage: 'Discord test failed',
      fetcher,
    });

    await expect(request).rejects.toMatchObject({
      name: 'DiscordRestError',
      status: 403,
      discordCode: 50001,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetcher.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts while waiting to retry a 429', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 20028 }), {
        status: 429,
        headers: { 'retry-after': '5' },
      }),
    );
    const request = requestDiscordJson({
      url: 'https://discord.com/api/v10/test',
      init: { signal: controller.signal },
      errorMessage: 'Discord test failed',
      fetcher,
    });

    controller.abort(new DOMException('stopped', 'AbortError'));

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
