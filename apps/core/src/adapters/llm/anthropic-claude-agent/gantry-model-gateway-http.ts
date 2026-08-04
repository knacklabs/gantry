import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  ModelGatewayResolvedUpstream,
  ModelProviderDefinition,
} from '../../../shared/model-provider-registry.js';
import { normalizeModelUsage } from '../../../shared/model-usage.js';

export interface GatewayResponsePayload {
  payload: Record<string, unknown>;
  requestModel?: string;
}

// One clone+parse shared by usage extraction, auditing, and span
// finalization. OK, non-streaming JSON responses only — error bodies are
// never awaited (a stalling upstream must not hang the proxied call).
export async function readGatewayResponsePayload(
  response: Response,
  requestBody: Buffer,
): Promise<GatewayResponsePayload | undefined> {
  if (!response.ok) return undefined;
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (contentType?.includes('text/event-stream')) {
    return undefined;
  }
  let requestModel: string | undefined;
  /* eslint-disable no-catch-all/no-catch-all -- multipart requests are expected to be non-JSON */
  try {
    const request = JSON.parse(requestBody.toString('utf8')) as Record<
      string,
      unknown
    >;
    if (request.stream === true) return undefined;
    requestModel =
      typeof request.model === 'string' ? request.model : undefined;
  } catch {
    // Multipart uploads have no JSON request model, but their successful JSON
    // response still carries authorization-relevant file metadata.
  }
  /* eslint-enable no-catch-all/no-catch-all */
  try {
    const payload: unknown = await response.clone().json();
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return undefined;
    }
    return {
      payload: payload as Record<string, unknown>,
      requestModel,
    };
  } catch {
    return undefined;
  }
}

export function usageFromGatewayPayload(
  parsed: GatewayResponsePayload | undefined,
): ReturnType<typeof normalizeModelUsage> {
  if (!parsed) return undefined;
  try {
    return normalizeModelUsage({
      message: parsed.payload,
      fallbackModel:
        typeof parsed.payload.model === 'string'
          ? parsed.payload.model
          : parsed.requestModel,
    });
  } catch {
    // Fail-open: malformed-but-successful upstream JSON must still proxy.
    return undefined;
  }
}

export const DEFAULT_LOOPBACK_HOST = '127.0.0.1';
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'openai-beta',
  'user-agent',
  'x-openrouter-cache',
  'x-openrouter-cache-clear',
  'x-openrouter-cache-ttl',
]);

const ALLOWED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-type',
  'x-amzn-requestid',
  'x-amz-request-id',
  'x-goog-request-id',
  'x-openrouter-cache-age',
  'x-openrouter-cache-status',
  'x-openrouter-cache-ttl',
  'x-request-id',
]);

export class GatewayRequestBodyTooLargeError extends Error {}
export class GatewayBadRequestError extends Error {}

export function normalizeGatewayBindHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === '127.0.0.1' || normalized === '::1') {
    return normalized;
  }
  throw new Error(
    'Gantry Model Gateway bind host must be a numeric loopback host: 127.0.0.1 or ::1.',
  );
}

export function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

export function buildConfinedUpstreamUrl(
  provider: ModelProviderDefinition,
  pathParts: string[],
  search: string,
  upstream?: ModelGatewayResolvedUpstream,
): URL {
  const decodedParts = pathParts.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new GatewayBadRequestError(
        'Model gateway request path is malformed.',
      );
    }
  });
  if (
    decodedParts.length === 0 ||
    decodedParts.some((part) => part === '.' || part === '..' || part === '')
  ) {
    throw new GatewayBadRequestError(
      'Model gateway request path is outside the provider route.',
    );
  }
  const upstreamPath = `/${decodedParts.map(encodeURIComponent).join('/')}`;
  const resolvedUpstream = upstream ?? {
    origin: provider.gateway.upstreamOrigin,
    pathPrefix: provider.gateway.upstreamPathPrefix,
  };
  const normalizedPrefix = normalizePathPrefix(resolvedUpstream.pathPrefix);
  const upstreamOrigin = normalizeUpstreamOrigin(resolvedUpstream.origin);
  const upstreamUrl = new URL(
    `${normalizedPrefix}${upstreamPath}${search}`,
    upstreamOrigin,
  );
  const requiredPrefix = normalizedPrefix === '' ? '/' : `${normalizedPrefix}/`;
  if (
    normalizedPrefix &&
    upstreamUrl.pathname !== normalizedPrefix &&
    !upstreamUrl.pathname.startsWith(requiredPrefix)
  ) {
    throw new GatewayBadRequestError(
      'Model gateway request path escaped provider prefix.',
    );
  }
  return upstreamUrl;
}

export function assertRawGatewayPathIsConfined(rawUrl: string): void {
  const rawPath = rawUrl.split('?')[0] || '/';
  for (const part of rawPath.split('/')) {
    if (!part) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new GatewayBadRequestError(
        'Model gateway request path is malformed.',
      );
    }
    if (decoded === '.' || decoded === '..') {
      throw new GatewayBadRequestError(
        'Model gateway request path is outside the provider route.',
      );
    }
  }
}

export function shouldForwardGatewayResponseHeader(key: string): boolean {
  return ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase());
}

export async function pipeUpstreamBody(
  response: Response,
  res: http.ServerResponse,
  tap?: { transform(chunk: Buffer): Buffer; flush(): Buffer },
): Promise<void> {
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );
  if (tap) {
    await pipeline(
      body,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try {
            callback(null, tap.transform(chunk));
          } catch {
            callback(null, chunk);
          }
        },
        flush(callback) {
          try {
            callback(null, tap.flush());
          } catch {
            callback();
          }
        },
      }),
      res,
    );
    return;
  }
  await pipeline(body, res);
}

export function readBearerToken(req: http.IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (Array.isArray(apiKey)) return apiKey[0] || '';
  return apiKey || '';
}

export function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function readRequestBody(
  req: http.IncomingMessage,
  limitBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > limitBytes) {
        reject(
          new GatewayRequestBodyTooLargeError(
            'Model gateway request body is too large.',
          ),
        );
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sanitizeProxyHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower)) {
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.join(', ');
    } else if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

export function sendGatewayJson(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!trimmed.startsWith('/')) {
    throw new Error('Model gateway upstream path prefix must start with /.');
  }
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('Model gateway upstream path prefix is invalid.');
  }
  return `/${parts.map(encodeURIComponent).join('/')}`;
}

function normalizeUpstreamOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new Error('Model gateway upstream origin is invalid.', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Model gateway upstream origin must be an HTTPS origin.');
  }
  return url.origin;
}
