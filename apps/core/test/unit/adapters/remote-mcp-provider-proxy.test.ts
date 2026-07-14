import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { describe, expect, it } from 'vitest';

import {
  createSseEndpointCapture,
  proxyTarget,
  type SseProxyEndpointState,
} from '@core/adapters/llm/anthropic-claude-agent/inline-lane/remote-mcp-proxy.js';

async function captureEndpoint(
  configuredTarget: URL,
  state: SseProxyEndpointState,
  chunks: string[],
  proxyTarget = new URL('http://127.0.0.1:43123/sse'),
): Promise<Buffer> {
  const output: Buffer[] = [];
  await pipeline(
    Readable.from(chunks),
    createSseEndpointCapture(configuredTarget, state, proxyTarget),
    new Writable({
      write: (chunk, _encoding, callback) => {
        output.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(output);
}

describe('inline remote MCP provider proxy confinement', () => {
  it('rewrites a relative SSE message endpoint to the loopback proxy', async () => {
    const configured = new URL('https://mcp.example/api/sse');
    const state: SseProxyEndpointState = {};

    expect(proxyTarget('/api/sse', configured, 'sse', state).href).toBe(
      configured.href,
    );
    expect(() =>
      proxyTarget(
        '/api/messages?sessionId=session-1',
        configured,
        'sse',
        state,
      ),
    ).toThrow('escaped its configured endpoint');

    const output = await captureEndpoint(configured, state, [
      ': heartbeat\r\n\r\nevent: end',
      'point\r\ndata: messages?sessionId=session-1\r\n\r\n',
    ]);

    expect(output.toString()).toBe(
      ': heartbeat\r\n\r\nevent: endpoint\r\ndata: http://127.0.0.1:43123/api/messages?sessionId=session-1\r\n\r\n',
    );
    expect(state.advertisedTarget?.href).toBe(
      'https://mcp.example/api/messages?sessionId=session-1',
    );
    expect(
      proxyTarget('/api/messages?sessionId=session-1', configured, 'sse', state)
        .href,
    ).toBe('https://mcp.example/api/messages?sessionId=session-1');
    expect(() =>
      proxyTarget('/api/messages?sessionId=other', configured, 'sse', state),
    ).toThrow('escaped its configured endpoint');
    expect(() => proxyTarget('/admin', configured, 'sse', state)).toThrow(
      'escaped its configured endpoint',
    );
  });

  it('rewrites an absolute same-origin endpoint that remains reachable through the proxy', async () => {
    const configured = new URL('https://mcp.example/api/sse');
    const state: SseProxyEndpointState = {};
    const output = await captureEndpoint(
      configured,
      state,
      [
        'event: endpoint\ndata: https://mcp.example/api/messages?sessionId=session-2\n\n',
      ],
      new URL('http://127.0.0.1:43123/api/sse'),
    );

    expect(output.toString()).toBe(
      'event: endpoint\ndata: http://127.0.0.1:43123/api/messages?sessionId=session-2\n\n',
    );
    expect(
      proxyTarget('/api/messages?sessionId=session-2', configured, 'sse', state)
        .href,
    ).toBe('https://mcp.example/api/messages?sessionId=session-2');
  });

  it('rejects advertised SSE message endpoints on another origin', async () => {
    const configured = new URL('https://mcp.example/sse');
    const state: SseProxyEndpointState = {};

    await expect(
      captureEndpoint(configured, state, [
        'event: endpoint\ndata: https://other.example/messages\n\n',
      ]),
    ).rejects.toThrow('invalid or not allowed');

    expect(state.advertisedTarget).toBeUndefined();
    expect(() => proxyTarget('/messages', configured, 'sse', state)).toThrow(
      'escaped its configured endpoint',
    );
  });

  it('forwards non-endpoint SSE chunks byte-identically', async () => {
    const chunks = [
      ': heartbeat\r\n\r\n',
      'event: message\ndata: {"ok":true}\n\n',
      'event: progress\ndata: partial',
    ];

    const output = await captureEndpoint(
      new URL('https://mcp.example/sse'),
      {},
      chunks,
    );

    expect(output).toEqual(Buffer.from(chunks.join('')));
  });
});
