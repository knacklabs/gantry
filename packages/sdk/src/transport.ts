import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { parseSessionSseEvent } from './session-events.js';
import type {
  ClientOptions,
  RequestOptions,
  SseEvent,
  TransportResponse,
} from './types.js';

export interface GantryError extends Error {
  code: string;
  statusCode?: number;
  details?: Record<string, unknown> | null;
  requestId?: string;
  retryable?: boolean;
  restartRequired?: boolean;
  nextAction?: string;
}

export class Transport {
  private readonly apiKey: string;
  private readonly baseUrl: URL;
  private readonly socketPath?: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = new URL(options.baseUrl || 'http://127.0.0.1:3939');
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  request<T>(options: RequestOptions): Promise<T> {
    return this.requestWithMetadata<T>(options).then(
      (response) => response.body,
    );
  }

  requestWithMetadata<T>(
    options: RequestOptions,
  ): Promise<TransportResponse<T>> {
    const url = new URL(options.path, this.baseUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const body =
      options.body === undefined
        ? undefined
        : options.body instanceof Uint8Array
          ? options.body
          : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: options.accept || 'application/json',
    };
    if (body) {
      headers['content-type'] =
        options.contentType ||
        (options.body instanceof Uint8Array
          ? 'application/octet-stream'
          : 'application/json');
    }
    if (options.traceparent) headers.traceparent = options.traceparent;
    return new Promise<TransportResponse<T>>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: this.socketPath ? undefined : url.hostname,
          port: this.socketPath ? undefined : url.port,
          path: `${url.pathname}${url.search}`,
          socketPath: this.socketPath,
          method: options.method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = {};
            try {
              parsed = parseJsonBody(raw);
            } catch (error) {
              reject(error);
              return;
            }
            if ((res.statusCode || 500) >= 400) {
              const error = toError(parsed);
              error.statusCode = res.statusCode;
              reject(error);
              return;
            }
            const responseHeaders: Record<string, string | undefined> = {};
            for (const [name, value] of Object.entries(res.headers)) {
              responseHeaders[name] = Array.isArray(value)
                ? value.join(', ')
                : value;
            }
            resolve({ body: parsed as T, headers: responseHeaders });
          });
        },
      );
      req.setTimeout(this.timeoutMs, () =>
        req.destroy(new Error('Gantry request timed out')),
      );
      req.on('error', reject);
      options.signal?.addEventListener(
        'abort',
        () => req.destroy(new Error('Gantry request aborted')),
        { once: true },
      );
      if (body) req.write(body);
      req.end();
    });
  }

  async *stream(
    pathname: string,
    signal?: AbortSignal,
  ): AsyncIterable<SseEvent> {
    const url = new URL(pathname, this.baseUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: url.protocol,
      hostname: this.socketPath ? undefined : url.hostname,
      port: this.socketPath ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      socketPath: this.socketPath,
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'text/event-stream',
      },
    });
    signal?.addEventListener(
      'abort',
      () => req.destroy(new Error('Gantry stream aborted')),
      { once: true },
    );
    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        req.on('response', resolve);
        req.on('error', reject);
        req.end();
      },
    );
    if ((response.statusCode || 500) >= 400) {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      throw toError(parseJsonBody(Buffer.concat(chunks).toString('utf8')));
    }
    let buffer = '';
    for await (const chunk of response) {
      buffer += chunk.toString();
      while (true) {
        const delimiter = buffer.indexOf('\n\n');
        if (delimiter < 0) break;
        const block = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        const lines = block.split('\n');
        const idLine = lines.find((line) => line.startsWith('id: '));
        const eventLine = lines.find((line) => line.startsWith('event: '));
        const dataLine = lines.find((line) => line.startsWith('data: '));
        if (!idLine || !eventLine || !dataLine) continue;
        yield parseSessionSseEvent({
          eventId: Number(idLine.slice(4).trim()),
          eventType: eventLine.slice(7).trim(),
          data: JSON.parse(dataLine.slice(6)),
        });
      }
    }
  }
}

function parseJsonBody(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(
      'Gantry returned a non-JSON response',
    ) as GantryError;
    error.code = 'INVALID_RESPONSE';
    throw error;
  }
}

function toError(input: unknown): GantryError {
  const fallback = new Error('Gantry request failed') as GantryError;
  fallback.code = 'UNKNOWN_ERROR';
  if (
    !input ||
    typeof input !== 'object' ||
    !('error' in input) ||
    !input.error ||
    typeof input.error !== 'object'
  ) {
    return fallback;
  }
  const value = input.error as Record<string, unknown>;
  const error = new Error(
    String(value.message || 'Gantry request failed'),
  ) as GantryError;
  error.code = String(value.code || 'UNKNOWN_ERROR');
  error.details =
    value.details && typeof value.details === 'object'
      ? (value.details as Record<string, unknown>)
      : null;
  error.requestId =
    typeof value.requestId === 'string' ? value.requestId : undefined;
  error.retryable =
    typeof value.retryable === 'boolean' ? value.retryable : undefined;
  error.restartRequired =
    typeof value.restartRequired === 'boolean'
      ? value.restartRequired
      : undefined;
  error.nextAction =
    typeof value.nextAction === 'string' ? value.nextAction : undefined;
  return error;
}
