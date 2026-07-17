import type { ZodType } from 'zod';

export type RuntimeRequest<T> = {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  schema: ZodType<T>;
  signal?: AbortSignal;
};

export type RuntimeStreamRequest<T> = {
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  schema: ZodType<T>;
  signal?: AbortSignal;
};

export interface RuntimeApiTransport {
  request<T>(request: RuntimeRequest<T>): Promise<T>;
  stream<T>(request: RuntimeStreamRequest<T>): AsyncIterable<T>;
}

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RuntimeApiError';
  }
}

export class LocalOwnerTransport implements RuntimeApiTransport {
  constructor(private readonly apiBase: string) {}

  async request<T>(request: RuntimeRequest<T>): Promise<T> {
    const method = request.method ?? 'GET';
    const response = await fetch(buildUrl(this.apiBase, request), {
      method,
      signal: request.signal,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-Gantry-UI-Request': '1',
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(method === 'GET'
        ? {}
        : {
            body:
              request.body === undefined ? '{}' : JSON.stringify(request.body),
          }),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw apiError(response, payload);
    return request.schema.parse(payload);
  }

  async *stream<T>(request: RuntimeStreamRequest<T>): AsyncIterable<T> {
    const response = await fetch(buildUrl(this.apiBase, request), {
      method: 'GET',
      signal: request.signal,
      cache: 'no-store',
      headers: {
        Accept: 'text/event-stream',
        'X-Gantry-UI-Request': '1',
      },
    });
    if (!response.ok) throw apiError(response, await readPayload(response));
    if (!response.body) {
      throw new RuntimeApiError('Runtime stream returned no body.', 502);
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          yield request.schema.parse(JSON.parse(data));
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function buildUrl(
  apiBase: string,
  request: Pick<RuntimeRequest<unknown>, 'path' | 'query'>,
): string {
  const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
  const path = request.path.startsWith('/') ? request.path : `/${request.path}`;
  const url = new URL(`${base}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: 'Runtime returned an invalid JSON response.' };
  }
}

function apiError(response: Response, payload: unknown): RuntimeApiError {
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const record =
    envelope.error &&
    typeof envelope.error === 'object' &&
    !Array.isArray(envelope.error)
      ? (envelope.error as Record<string, unknown>)
      : envelope;
  const message =
    typeof record.message === 'string'
      ? record.message
      : `Runtime request failed with status ${response.status}.`;
  return new RuntimeApiError(
    message,
    response.status,
    typeof record.code === 'string' ? record.code : undefined,
  );
}
