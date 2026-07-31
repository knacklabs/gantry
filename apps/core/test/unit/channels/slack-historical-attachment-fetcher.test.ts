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
    ['missing_scope', 'auth'],
    ['invalid_auth', 'auth'],
    ['ratelimited', 'rate_limit'],
    ['slack_webapi_rate_limited_error', 'rate_limit'],
    ['slack_webapi_request_error', 'network'],
    ['slack_webapi_http_error', 'network'],
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

  it('keeps network download failures unreachable', async () => {
    const result = await fetchSlackHistoricalAttachment(
      { identity },
      {
        filesInfo: vi.fn(async () => ({
          file: { url_private: 'https://files.slack.test/F123' },
        })),
        download: vi.fn(async () => {
          throw new Error('socket closed');
        }),
      },
    );

    expect(result).toEqual({ status: 'unreachable', reason: 'network' });
  });

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
    ).resolves.toEqual({ status: 'unreachable', reason: 'not_found' });
    await expect(
      classifySlackDownloadResponse(
        new Response('ratelimited', { status: 429 }),
      ),
    ).resolves.toEqual({ status: 'unreachable', reason: 'rate_limit' });
    await expect(
      classifySlackDownloadResponse(
        new Response('invalid_auth', { status: 401 }),
      ),
    ).resolves.toEqual({ status: 'unreachable', reason: 'auth' });
  });
});
