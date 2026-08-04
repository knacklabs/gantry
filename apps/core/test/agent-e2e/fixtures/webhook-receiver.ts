// Minimal loopback receiver capturing POSTed payloads for assertions.
import http from 'node:http';

import { closeServer, listenLoopback } from './loopback-http.js';

const CAPTURED_HEADER_ALLOWLIST = ['content-type', 'authorization'];

export interface CapturedWebhookRequest {
  method: string;
  path: string;
  /** content-type, authorization, and x-* headers only. */
  headers: Record<string, string>;
  /** Parsed JSON body, or the raw string when not valid JSON. */
  body: unknown;
}

export interface WebhookReceiver {
  url: string;
  requests: CapturedWebhookRequest[];
  stop(): Promise<void>;
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const requests: CapturedWebhookRequest[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw.length ? JSON.parse(raw) : undefined;
      } catch {
        // Keep the raw string.
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          typeof value === 'string' &&
          (CAPTURED_HEADER_ALLOWLIST.includes(name) || name.startsWith('x-'))
        ) {
          headers[name] = value;
        }
      }
      requests.push({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers,
        body,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    })();
  });
  const url = await listenLoopback(server);
  return { url, requests, stop: () => closeServer(server) };
}
