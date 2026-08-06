import { describe, expect, it, vi } from 'vitest';

import {
  classifySlackDownloadResponse,
  fetchSlackHistoricalAttachment,
} from '@core/channels/slack/historical-attachment-fetcher.js';

const identity = {
  provider: 'slack',
  kind: 'file_id',
  id: 'F123',
};

function slackError(error: string) {
  return Object.assign(new Error(error), { data: { error } });
}

describe('Slack historical attachment fetch taxonomy', () => {
  it('uses files.info and the bearer download response for successful content', async () => {
    const filesInfo = vi.fn(async () => ({
      file: {
        name: 'report.txt',
        mimetype: 'text/plain',
        url_private_download: 'https://files.slack.test/F123',
      },
    }));
    const download = vi.fn(
      async () => new Response('historical bytes', { status: 200 }),
    );

    const result = await fetchSlackHistoricalAttachment(
      { identity },
      { filesInfo, download },
    );

    expect(filesInfo).toHaveBeenCalledWith('F123');
    expect(download).toHaveBeenCalledWith('https://files.slack.test/F123');
    expect(result).toMatchObject({
      status: 'ok',
      fileName: 'report.txt',
      contentType: 'text/plain',
    });
    if (result.status !== 'ok' || !('read' in result.content)) {
      throw new Error('expected streaming Slack content');
    }
    const chunk = await result.content.read();
    expect(Buffer.from(chunk.value ?? []).toString('utf8')).toBe(
      'historical bytes',
    );
  });

  it('propagates cancellation to the Slack response body reader', async () => {
    const cancelBody = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel: cancelBody,
      }),
      { status: 200, headers: { 'content-type': 'application/octet-stream' } },
    );
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => ({
          file: {
            name: 'report.bin',
            url_private_download: 'https://files.slack.test/F123',
          },
        })),
        download: vi.fn(async () => response),
      },
    );
    if (result.status !== 'ok' || !('read' in result.content)) {
      throw new Error('expected streaming Slack content');
    }

    await result.content.cancel('too_large');

    expect(cancelBody).toHaveBeenCalledWith('too_large');
  });

  it('reports unsupported provider identity as incapable data', async () => {
    const filesInfo = vi.fn();
    const result = await fetchSlackHistoricalAttachment(
      {
        identity: { provider: 'discord', kind: 'file_id', id: 'F123' },
      },
      { filesInfo, download: vi.fn() },
    );

    expect(result).toEqual({ status: 'unreachable', reason: 'incapable' });
    expect(filesInfo).not.toHaveBeenCalled();
  });

  it('classifies only explicit file_deleted as deleted', async () => {
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => {
          throw slackError('file_deleted');
        }),
        download: vi.fn(),
      },
    );

    expect(result).toEqual({ status: 'deleted' });
  });

  it.each([
    ['file_not_found', 'not_found'],
    ['not_visible', 'not_visible'],
    ['invalid_auth', 'unknown'],
    ['ratelimited', 'rate_limit'],
    ['slack_webapi_rate_limited_error', 'rate_limit'],
    ['not_in_channel', 'unknown'],
    ['channel_not_found', 'unknown'],
    ['file_not_visible', 'unknown'],
  ] as const)('keeps Slack %s non-tombstoning as %s', async (error, reason) => {
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => {
          throw slackError(error);
        }),
        download: vi.fn(),
      },
    );

    expect(result).toEqual({ status: 'unreachable', reason });
  });

  it('emits explicit files:read scope evidence for Slack missing_scope', async () => {
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => {
          throw Object.assign(slackError('missing_scope'), {
            code: 'slack_webapi_http_error',
            statusCode: 403,
          });
        }),
        download: vi.fn(),
      },
    );

    expect(result).toEqual({
      status: 'unreachable',
      reason: 'missing_scope',
      scope: 'files:read',
      providerStatus: 403,
    });
  });

  it.each([
    Object.assign(new Error('unauthorized'), {
      code: 'slack_webapi_http_error',
      statusCode: 401,
    }),
    Object.assign(new Error('forbidden'), {
      code: 'slack_webapi_http_error',
      statusCode: 403,
    }),
  ])('keeps SDK HTTP-error authorization status unknown', async (error) => {
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => {
          throw error;
        }),
        download: vi.fn(),
      },
    );

    expect(result).toEqual({
      status: 'unreachable',
      reason: 'unknown',
      providerStatus: error.statusCode,
    });
  });

  it('preserves an SDK rate-limit error as rate-limit evidence', async () => {
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => {
          throw Object.assign(new Error('rate limited'), {
            code: 'slack_webapi_rate_limited_error',
            statusCode: 429,
            retryAfter: 30,
          });
        }),
        download: vi.fn(),
      },
    );

    expect(result).toEqual({
      status: 'unreachable',
      reason: 'rate_limit',
      providerStatus: 429,
    });
  });

  it('preserves the SDK request-error code as transport evidence', async () => {
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => {
          throw Object.assign(new Error('request failed'), {
            code: 'slack_webapi_request_error',
          });
        }),
        download: vi.fn(),
      },
    );

    expect(result).toEqual({ status: 'unreachable', reason: 'network' });
  });

  it('keeps network download failures unreachable', async () => {
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => ({
          file: { url_private: 'https://files.slack.test/F123' },
        })),
        download: vi.fn(async () => {
          throw Object.assign(new Error('socket closed'), {
            code: 'ECONNRESET',
          });
        }),
      },
    );

    expect(result).toEqual({ status: 'unreachable', reason: 'network' });
  });

  it.each([200, 404])(
    'keeps an HTML download response with status %s unreachable and non-deleting',
    async (status) => {
      await expect(
        classifySlackDownloadResponse(
          new Response('file_deleted', {
            status,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
          'report.txt',
        ),
      ).resolves.toEqual({
        status: 'unreachable',
        reason: 'unknown',
        providerStatus: status,
      });
    },
  );

  it('recognizes explicit file_deleted in a failed download body', async () => {
    await expect(
      classifySlackDownloadResponse(
        new Response(JSON.stringify({ ok: false, error: 'file_deleted' }), {
          status: 404,
        }),
      ),
    ).resolves.toEqual({ status: 'deleted' });
  });

  it('does not infer deletion from HTTP status alone', async () => {
    await expect(
      classifySlackDownloadResponse(
        new Response(JSON.stringify({ ok: false, error: 'file_not_found' }), {
          status: 404,
        }),
      ),
    ).resolves.toEqual({
      status: 'unreachable',
      reason: 'not_found',
      providerStatus: 404,
    });
    await expect(
      classifySlackDownloadResponse(
        new Response('ratelimited', { status: 429 }),
      ),
    ).resolves.toEqual({
      status: 'unreachable',
      reason: 'rate_limit',
      providerStatus: 429,
    });
    await expect(
      classifySlackDownloadResponse(
        new Response('invalid_auth', { status: 401 }),
      ),
    ).resolves.toEqual({
      status: 'unreachable',
      reason: 'unknown',
      providerStatus: 401,
    });
    await expect(
      classifySlackDownloadResponse(new Response('', { status: 403 })),
    ).resolves.toEqual({
      status: 'unreachable',
      reason: 'unknown',
      providerStatus: 403,
    });
  });
});
