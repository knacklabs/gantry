import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readJson, readRawBody } from '@core/control/server/http.js';

function makeRequest(input: {
  headers?: Record<string, string | string[]>;
  chunks?: Buffer[];
}): any {
  const req = new PassThrough() as any;
  req.headers = input.headers ?? {};
  queueMicrotask(() => {
    for (const chunk of input.chunks ?? []) {
      req.write(chunk);
    }
    req.end();
  });
  return req;
}

describe('control http body readers', () => {
  it('rejects raw bodies when content-length exceeds the max bytes', async () => {
    const req = makeRequest({
      headers: { 'content-length': String(1024) },
      chunks: [Buffer.from('ok')],
    });

    await expect(readRawBody(req, 16)).rejects.toThrow('Payload too large');
  });

  it('rejects raw bodies when streamed data exceeds max bytes', async () => {
    const req = makeRequest({
      chunks: [Buffer.alloc(10), Buffer.alloc(10)],
    });

    await expect(readRawBody(req, 16)).rejects.toThrow('Payload too large');
  });

  it('rejects json payloads when content-length exceeds parser max bytes', async () => {
    const req = makeRequest({
      headers: { 'content-length': String(70 * 1024) },
      chunks: [Buffer.from('{"hello":"world"}')],
    });

    await expect(readJson(req)).rejects.toThrow('Payload too large');
  });

  it('uses the first content-length header value when headers are arrays', async () => {
    const req = makeRequest({
      headers: { 'content-length': [String(1024), '1'] },
      chunks: [Buffer.from('ok')],
    });

    await expect(readRawBody(req, 16)).rejects.toThrow('Payload too large');
  });
});
