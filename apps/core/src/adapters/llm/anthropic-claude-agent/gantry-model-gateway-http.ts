import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ModelProviderDefinition } from '../../../shared/model-provider-registry.js';

export const DEFAULT_LOOPBACK_HOST = '127.0.0.1';
export const ALLOWED_GATEWAY_METHODS = new Set(['POST']);

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
  const normalizedPrefix = normalizePathPrefix(
    provider.gateway.upstreamPathPrefix,
  );
  const upstreamUrl = new URL(
    `${normalizedPrefix}${upstreamPath}${search}`,
    provider.gateway.upstreamOrigin,
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
): Promise<void> {
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    res,
  );
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
