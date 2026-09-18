import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  observePage,
  pageState,
} from '@core/adapters/browser/browser-direct-session.js';

describe('browser direct session network observations', () => {
  it('records bounded structured API evidence while redacting secret fields', async () => {
    const page = new EventEmitter();
    const response = {
      status: () => 200,
      ok: () => true,
      headers: () => ({
        'content-type': 'application/json; charset=utf-8',
        'content-length': '123',
      }),
      text: async () =>
        JSON.stringify({
          rows: [{ noticeId: 'UNGM-123', title: 'Public tender' }],
          total: 1484,
          accessToken: 'must-not-leak',
        }),
    };
    const request = {
      method: () => 'POST',
      url: () => 'https://example.test/Public/Notice/Search',
      resourceType: () => 'xhr',
      postData: () =>
        JSON.stringify({ page: 2, pageSize: 15, password: 'must-not-leak' }),
      headers: () => ({
        authorization: 'Bearer must-not-leak',
        'content-type': 'application/json; charset=utf-8',
      }),
      response: async () => response,
      failure: () => null,
    };

    observePage(page as never);
    page.emit('request', request);
    page.emit('requestfinished', request);
    await new Promise((resolve) => setImmediate(resolve));

    expect(pageState(page as never).network).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: 'https://example.test/Public/Notice/Search',
        status: 200,
        requestBody: {
          contentType: 'application/json',
          value: { page: 2, pageSize: 15, password: '[REDACTED]' },
          truncated: false,
        },
        responseBody: {
          contentType: 'application/json',
          value: {
            rows: [{ noticeId: 'UNGM-123', title: 'Public tender' }],
            total: 1484,
            accessToken: '[REDACTED]',
          },
          truncated: false,
        },
      }),
    ]);
    expect(JSON.stringify(pageState(page as never).network)).not.toContain(
      'must-not-leak',
    );
  });

  it('captures and redacts JSON returned with a text/plain content type', async () => {
    const page = new EventEmitter();
    const response = {
      status: () => 200,
      ok: () => true,
      headers: () => ({ 'content-type': 'text/plain; charset=utf-8' }),
      text: async () =>
        JSON.stringify({
          data: [{ id: 1, title: 'Tender' }],
          total: 1510,
          sessionToken: 'must-not-leak',
        }),
    };
    const request = {
      method: () => 'POST',
      url: () => 'https://example.test/Public/Notice/Search',
      resourceType: () => 'xhr',
      postData: () => JSON.stringify({ PageIndex: 0, PageSize: 15 }),
      headers: () => ({ 'content-type': 'application/json' }),
      response: async () => response,
      failure: () => null,
    };

    observePage(page as never);
    page.emit('request', request);
    page.emit('requestfinished', request);
    await new Promise((resolve) => setImmediate(resolve));

    expect(pageState(page as never).network[0]?.responseBody).toEqual({
      contentType: 'text/plain',
      value: {
        data: [{ id: 1, title: 'Tender' }],
        total: 1510,
        sessionToken: '[REDACTED]',
      },
      truncated: false,
    });
  });
});
